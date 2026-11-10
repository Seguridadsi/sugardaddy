/*
 * Acceso a la consola por IP (docs/diseno/acceso-consola.md), en la base de
 * verdad: qué se guarda, cuándo no se deja guardar (quedarse fuera, cortar a un
 * sensor remoto, un formulario viejo), las máquinas de los sensores, la
 * emergencia, lo que recibe y confirma el cortafuegos, y la segunda barrera.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

describe.skipIf(!process.env.DATABASE_URL)('acceso a la consola', async () => {
	const { db, schema: s } = await import('./db');
	const { eq, inArray, like } = await import('drizzle-orm');
	const a = await import('./acceso');
	const CLAVES = ['acceso-consola', 'acceso-consola-cortafuegos'];
	const QUIEN = 'zz-acceso@prueba';
	const PREFIJO = 'zz-acceso-';

	const sensor = (id: string, direccion: string | null) =>
		db.insert(s.sensores).values({
			id: PREFIJO + id,
			nombre: `Sede ${id}`,
			claveHash: `${PREFIJO}${id}-hash`,
			remoto: true,
			direccion
		});

	const limpiar = async () => {
		await db.delete(s.ajustes).where(inArray(s.ajustes.clave, CLAVES));
		await db.delete(s.auditoria).where(inArray(s.auditoria.quien, [QUIEN, 'machine']));
		await db.delete(s.sensores).where(like(s.sensores.id, `${PREFIJO}%`));
		a._olvidarAcceso();
		a._ponerPuertaDeEnlace(undefined);
		delete process.env.CONSOLA_ACCESO;
	};
	beforeEach(limpiar);
	afterAll(limpiar);

	it('sin decidir, pendiente; con la lista del instalador, limitada desde el principio', async () => {
		expect((await a.leerAcceso()).estado).toBe('pendiente');
		process.env.CONSOLA_ACCESO = '10.0.5.20, 192.168.10.7/24 nada';
		a._olvidarAcceso();
		const x = await a.leerAcceso();
		expect(x.estado).toBe('restringida');
		expect(x.entradas.map((e) => e.red)).toEqual(['10.0.5.20', '192.168.10.0/24']);
		const p = await a.paraElCortafuegos();
		expect(p).toMatchObject({ estado: 'restringida', redes: ['10.0.5.20', '192.168.10.0/24'] });
		expect(p.huella).toMatch(/^[0-9a-f]{32}$/);
	});

	it('no deja guardar una lista que deja fuera a quien la guarda', async () => {
		const r = await a.guardarAcceso(QUIEN, [{ red: '10.0.5.20' }], '10.0.9.9', false);
		expect(r.ok).toBe(false);
		expect((await a.leerAcceso()).estado).toBe('pendiente');
		/* Sin saber su IP, tampoco: no se puede comprobar. */
		expect((await a.guardarAcceso(QUIEN, [{ red: '10.0.5.20' }], null, false)).ok).toBe(false);
		/* Desde la propia máquina sí. */
		expect((await a.guardarAcceso(QUIEN, [{ red: '10.0.5.20' }], '172.18.0.1', true)).ok).toBe(
			true
		);
	});

	it('guarda la lista limpia y deja auditoría', async () => {
		const r = await a.guardarAcceso(
			QUIEN,
			[
				{ red: ' 10.0.9.9 ', nota: 'Admin PC' },
				{ red: '192.168.10.77/24', nota: 'Admin network' },
				{ red: '10.0.9.9', nota: 'repetida' },
				{ red: '', nota: 'vacía' }
			],
			'10.0.9.9',
			false
		);
		expect(r.ok).toBe(true);
		const x = await a.leerAcceso();
		expect(x).toMatchObject({ estado: 'restringida', quien: QUIEN, version: 1 });
		expect(x.entradas).toEqual([
			{ red: '10.0.9.9', nota: 'Admin PC' },
			{ red: '192.168.10.0/24', nota: 'Admin network' }
		]);
		const [aud] = await db.select().from(s.auditoria).where(eq(s.auditoria.quien, QUIEN));
		expect(aud.accion).toBe('console access limited');
	});

	it('rechaza lo que no es una IP o red, 0.0.0.0/0 y las redes IPv4 escritas como IPv6', async () => {
		for (const red of [
			'0.0.0.0/0',
			'::/0',
			'10.0.0.300',
			'acme.com',
			'10.0.0.0/33',
			'::ffff:0:0/96',
			'::ffff:10.0.0.0/104'
		])
			expect((await a.guardarAcceso(QUIEN, [{ red }], '127.0.0.1', true)).ok, red).toBe(false);
		expect((await a.guardarAcceso(QUIEN, [], '127.0.0.1', true)).ok).toBe(false);
		/* Una IPv4 sola escrita como IPv6 sí: se guarda como IPv4. */
		expect(a.entradaValida('::ffff:10.0.0.7')).toBe('10.0.0.7');
	});

	it('un formulario viejo no pisa lo que cambió mientras tanto', async () => {
		await a.guardarAcceso(QUIEN, [{ red: '10.0.9.9' }], '10.0.9.9', false);
		const v = (await a.leerAcceso()).version!;
		await a.anadirSensorAlAcceso(QUIEN, PREFIJO + 'bilbao', 'Bilbao', '10.70.0.15');
		const r = await a.guardarAcceso(QUIEN, [{ red: '10.0.9.9' }], '10.0.9.9', false, {
			version: v
		});
		expect(r.ok).toBe(false);
		expect((await a.leerAcceso()).entradas.map((e) => e.red)).toEqual(['10.0.9.9', '10.70.0.15']);
	});

	it('no corta sin decirlo a un sensor remoto que ya conecta desde fuera de la lista', async () => {
		await sensor('sevilla', '10.80.0.4');
		await sensor('sin-ver', null);
		const r = await a.guardarAcceso(QUIEN, [{ red: '10.0.9.9' }], '10.0.9.9', false);
		expect(r.ok).toBe(false);
		expect(!r.ok && r.error).toContain('Sede sevilla (10.80.0.4)');
		expect((await a.sensoresSinDireccion()).map((x) => x.id)).toContain(PREFIJO + 'sin-ver');
		expect(
			(
				await a.guardarAcceso(QUIEN, [{ red: '10.0.9.9' }], '10.0.9.9', false, {
					cortarSensores: true
				})
			).ok
		).toBe(true);
		/* Con su máquina en la lista, sin más. */
		expect(
			(
				await a.guardarAcceso(
					QUIEN,
					[{ red: '10.0.9.9' }, { red: '10.80.0.0/24' }],
					'10.0.9.9',
					false
				)
			).ok
		).toBe(true);
		expect(await a.sensoresFuera((await a.leerAcceso()).entradas)).toEqual([]);
	});

	it('apunta desde dónde llega un sensor remoto', async () => {
		await sensor('vigo', null);
		await a.apuntarDireccionSensor(PREFIJO + 'vigo', () => '::ffff:10.90.0.8');
		const [f] = await db
			.select()
			.from(s.sensores)
			.where(eq(s.sensores.id, PREFIJO + 'vigo'));
		expect(f.direccion).toBe('10.90.0.8');
	});

	it('la máquina de un sensor entra en la lista, sin pisar ni llevarse entradas que no son suyas', async () => {
		await a.guardarAcceso(QUIEN, [{ red: '10.0.9.9', nota: 'Admin' }], '10.0.9.9', false);
		expect(await a.anadirSensorAlAcceso(QUIEN, 'zz-sevilla', 'Seville', '10.70.0.0/24')).toBe(
			'Enter the IP address of the sensor machine.'
		);
		await a.anadirSensorAlAcceso(QUIEN, 'zz-sevilla', 'Seville', '10.70.0.15');
		/* Otra vez, con otra IP: la sustituye. */
		await a.anadirSensorAlAcceso(QUIEN, 'zz-sevilla', 'Seville', '10.70.0.16');
		expect((await a.leerAcceso()).entradas).toEqual([
			{ red: '10.0.9.9', nota: 'Admin' },
			{ red: '10.70.0.16', nota: 'Remote sensor Seville', sensor: 'zz-sevilla' }
		]);
		/* Un sensor en la misma IP que el puesto del admin: ya entra, no se añade nada. */
		await a.anadirSensorAlAcceso(QUIEN, 'zz-salto', 'Jump host', '10.0.9.9');
		await a.quitarSensorDelAcceso(QUIEN, 'zz-salto', '10.0.9.9', false);
		expect((await a.leerAcceso()).entradas.map((e) => e.red)).toEqual(['10.0.9.9', '10.70.0.16']);
		await a.quitarSensorDelAcceso(QUIEN, 'zz-sevilla', '10.0.9.9', false);
		const x = await a.leerAcceso();
		expect(x.entradas.map((e) => e.red)).toEqual(['10.0.9.9']);
		expect(x.estado).toBe('restringida');
	});

	it('borrar un sensor nunca vacía la lista ni deja fuera a quien lo borra', async () => {
		/* Guardada desde la máquina, con solo la entrada del sensor. */
		await a.guardarAcceso(QUIEN, [{ red: '10.0.9.9' }], '172.18.0.1', true);
		await a.anadirSensorAlAcceso(QUIEN, 'zz-unico', 'Only', '10.70.0.20');
		await a.guardarAcceso(QUIEN, [{ red: '10.70.0.20', sensor: 'zz-unico' }], '172.18.0.1', true);
		await a.quitarSensorDelAcceso(QUIEN, 'zz-unico', '172.18.0.1', true);
		let x = await a.leerAcceso();
		expect(x).toMatchObject({ estado: 'restringida', entradas: [{ red: '10.70.0.20', nota: '' }] });
		/* Quien lo borra entraba solo por esa entrada: se queda, ya sin el sensor. */
		await a.guardarAcceso(QUIEN, [{ red: '10.0.9.9' }], '10.0.9.9', false);
		await a.anadirSensorAlAcceso(QUIEN, 'zz-puesto', 'Desk', '10.70.0.30');
		await a.quitarSensorDelAcceso(QUIEN, 'zz-puesto', '10.70.0.30', false);
		x = await a.leerAcceso();
		expect(x.entradas.map((e) => e.red)).toEqual(['10.0.9.9', '10.70.0.30']);
		expect(x.entradas[1].sensor).toBeUndefined();
	});

	it('la emergencia de la máquina la deja abierta y lo apunta; volver a guardar la limita', async () => {
		await a.guardarAcceso(QUIEN, [{ red: '10.0.9.9' }], '10.0.9.9', false);
		await a.abiertaPorEmergencia();
		const x = await a.leerAcceso();
		expect(x).toMatchObject({ estado: 'abierta', emergencia: true });
		expect(x.entradas.map((e) => e.red)).toEqual(['10.0.9.9']);
		expect(a.puedeEntrar('203.0.113.9', x, false)).toBe(true);
		const [aud] = await db.select().from(s.auditoria).where(eq(s.auditoria.quien, 'machine'));
		expect(aud.accion).toBe('console access opened from the machine');
		expect(await a.paraElCortafuegos()).toMatchObject({ estado: 'abierta', redes: [] });
		await a.guardarAcceso(QUIEN, x.entradas, '10.0.9.9', false);
		const y = await a.leerAcceso();
		expect(y.estado).toBe('restringida');
		expect(y.emergencia).toBeUndefined();
	});

	it('el cortafuegos solo confirma la lista que aplicó, y hace poco', async () => {
		await a.guardarAcceso(QUIEN, [{ red: '10.0.9.9' }], '10.0.9.9', false);
		const x = await a.leerAcceso();
		const { huella } = await a.paraElCortafuegos();
		expect(a.cortafuegosConfirma(x, await a.cortafuegos())).toBe(false);
		expect(await a.guardarCortafuegos('borrado', 'x')).toBe(false);
		await a.guardarCortafuegos('aplicada', 'IPv4 with iptables-nft', huella);
		expect(a.cortafuegosConfirma(x, await a.cortafuegos())).toBe(true);
		/* De hace un cuarto de hora: el actualizador no está. */
		expect(a.cortafuegosConfirma(x, await a.cortafuegos(), Date.now() + 15 * 60_000)).toBe(false);
		/* Otra lista: no vale la confirmación de la anterior. */
		await a.guardarAcceso(QUIEN, [{ red: '10.0.9.9' }, { red: '10.0.9.10' }], '10.0.9.9', false);
		expect(a.cortafuegosConfirma(await a.leerAcceso(), await a.cortafuegos())).toBe(false);
		await a.guardarCortafuegos('sin-docker-user', 'no DOCKER-USER', huella);
		expect(await a.cortafuegos()).toMatchObject({ estado: 'sin-docker-user' });
	});

	it('la segunda barrera: la lista, el bucle local y la puerta de enlace solo con el cortafuegos confirmado', async () => {
		await a.guardarAcceso(
			QUIEN,
			[{ red: '10.0.9.9' }, { red: '192.168.10.0/24' }],
			'10.0.9.9',
			false
		);
		a._ponerPuertaDeEnlace('172.18.0.1');
		const x = await a.leerAcceso();
		expect(a.puedeEntrar('192.168.10.200', x, false)).toBe(true);
		expect(a.puedeEntrar('10.0.9.10', x, true)).toBe(false);
		expect(a.puedeEntrar(null, x, true)).toBe(false);
		expect(a.puedeEntrar('127.0.0.1', x, false)).toBe(true);
		/* Sin el cortafuegos, por la puerta de enlace llega también lo que Docker reenvía. */
		expect(a.puedeEntrar('172.18.0.1', x, false)).toBe(false);
		expect(a.puedeEntrar('172.18.0.1', x, true)).toBe(true);
		expect(a.esLocal('172.18.0.1')).toBe(true);
	});
});
