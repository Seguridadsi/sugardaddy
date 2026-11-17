/*
 * La máquina del nodo (anfitrion.ts, docs/diseno/cortafuegos-anfitrion.md), en la base
 * de verdad: el modo estricto de serie, lo que recibe el actualizador, lo que pasa a la
 * auditoría (y de ahí al SIEM como integridad.anfitrion) y el resumen del latido.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { borrarAuditoriaDePrueba } from './db/pruebas-auditoria';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

describe('anfitrion: validaciones', async () => {
	const a = await import('./anfitrion');
	it('destinos host:puerto', () => {
		expect(a.destinoValido('SIEM.example.com:6514')).toBe('siem.example.com:6514');
		expect(a.destinoValido('[2001:db8::1]:443')).toBe('[2001:db8::1]:443');
		expect(a.destinoValido('10.0.0.5:514')).toBe('10.0.0.5:514');
		for (const malo of ['siem.example.com', 'x:0', 'x:70000', 'a..b:1', 'http://x:1', 'x y:1'])
			expect(a.destinoValido(malo)).toBeNull();
	});
	it('el proxy, sin usuario ni contraseña', () => {
		expect(a.destinoDeProxy('http://user:secret@proxy.corp:3128')).toBe('proxy.corp:3128');
		expect(a.destinoDeProxy('https://proxy.corp')).toBe('proxy.corp:443');
		expect(a.destinoDeProxy('nada')).toBeNull();
	});
	it('lo que manda el actualizador, acotado', () => {
		const h = a.leerHechos({
			docker: { version: '28.5.0', fijada: '29.9.1', desfasada: true },
			maquina: {
				appliance: true,
				ssh: {
					activo: true,
					usuarios: [
						{
							usuario: 'kino',
							uid: 1000,
							claves: 2,
							huellas: ['SHA256:DOMK9YseJeuM3ok+0V5N+kf3txhuUes79foP4UYu+YA', '<script>']
						}
					]
				},
				auditd: { estado: 'puesta' },
				docker: { actualizacion: 'lanzada' }
			}
		});
		expect(h?.ssh.usuarios[0].huellas).toEqual([
			'SHA256:DOMK9YseJeuM3ok+0V5N+kf3txhuUes79foP4UYu+YA'
		]);
		expect(h?.docker).toMatchObject({ version: '28.5.0', fijada: '29.9.1', desfasada: true });
		expect(a.leerHechos({ docker: {} })).toBeNull();
		expect(a.leerHechos(null)).toBeNull();
	});
});

describe.skipIf(!process.env.DATABASE_URL)('anfitrion en la base', async () => {
	const { db, schema: s } = await import('./db');
	const { inArray, like, or, eq, and, gt, desc } = await import('drizzle-orm');
	const a = await import('./anfitrion');
	const CLAVES = [
		'cortafuegos-anfitrion',
		'anfitrion-hechos',
		'anfitrion-cortafuegos',
		'acceso-consola',
		'separacion-credenciales'
	];
	const QUIEN = 'zz-anfitrion@prueba';
	const SENSOR = { id: 'zz-anfitrion-remoto', nombre: 'zz-anfitrion-remoto' };
	let desde = 0;

	const limpiar = async () => {
		await db.delete(s.ajustes).where(inArray(s.ajustes.clave, CLAVES));
		await db.delete(s.ajustes).where(like(s.ajustes.clave, `%:sensor:${SENSOR.id}`));
		await db.delete(s.sensores).where(eq(s.sensores.id, SENSOR.id));
		await borrarAuditoriaDePrueba(
			db,
			or(
				eq(s.auditoria.quien, QUIEN),
				like(s.auditoria.quien, 'node machine%'),
				like(s.auditoria.quien, `sensor ${SENSOR.nombre} machine%`)
			)
		);
		const [u] = await db
			.select({ id: s.auditoria.id })
			.from(s.auditoria)
			.orderBy(desc(s.auditoria.id))
			.limit(1);
		desde = u?.id ?? 0;
	};
	const filas = () =>
		db
			.select()
			.from(s.auditoria)
			.where(and(gt(s.auditoria.id, desde), like(s.auditoria.quien, 'node machine%')))
			.orderBy(s.auditoria.id);
	beforeEach(limpiar);
	afterAll(limpiar);

	it('de serie, apagado; encendido en el appliance', async () => {
		expect((await a.estrictoEfectivo()).activo).toBe(false);
		await a.recibirHechos(
			a.leerHechos({ docker: { desfasada: false }, maquina: { appliance: true } })!
		);
		expect(await a.estrictoEfectivo()).toMatchObject({ activo: true, motivo: 'appliance' });
		/* Lo que diga el cliente manda. */
		await a.guardarAjusteAnfitrion(QUIEN, {
			estricto: false,
			sshPuerto: 22,
			sshRedes: [],
			restringida: false,
			destinos: []
		});
		expect((await a.estrictoEfectivo()).activo).toBe(false);
	});

	it('el perfil bancario lo enciende', async () => {
		expect(await a.encenderEstricto(QUIEN)).toBe(true);
		expect(await a.encenderEstricto(QUIEN)).toBe(false);
		expect((await a.estrictoEfectivo()).activo).toBe(true);
	});

	it('valida el ajuste', async () => {
		const base = { estricto: true, sshPuerto: 22, sshRedes: [], restringida: true, destinos: [] };
		expect(
			await a.guardarAjusteAnfitrion(QUIEN, { ...base, sshRedes: ['0.0.0.0/0'] })
		).toMatchObject({
			ok: false
		});
		expect(await a.guardarAjusteAnfitrion(QUIEN, { ...base, sshPuerto: 0 })).toMatchObject({
			ok: false
		});
		expect(await a.guardarAjusteAnfitrion(QUIEN, { ...base, destinos: ['siem'] })).toMatchObject({
			ok: false
		});
		expect(
			await a.guardarAjusteAnfitrion(QUIEN, {
				...base,
				sshRedes: ['192.0.2.0/24', '192.0.2.0/24'],
				destinos: ['SIEM.example.com:6514']
			})
		).toEqual({ ok: true });
		const aj = await a.ajusteAnfitrion();
		expect(aj.ssh.redes).toEqual(['192.0.2.0/24']);
		expect(aj.salida.destinos).toEqual(['siem.example.com:6514']);
	});

	it('lo que pregunta el actualizador: consola, SSH y salida (con proxy, solo el proxy)', async () => {
		await a.guardarAjusteAnfitrion(QUIEN, {
			estricto: true,
			sshPuerto: 2222,
			sshRedes: ['192.0.2.0/24'],
			restringida: true,
			destinos: ['siem.example.com:6514']
		});
		const sin = await a.paraElActualizador({ REGISTRO: 'ghcr.io' });
		expect(sin.estricto).toBe(true);
		expect(sin.ssh).toEqual({ puerto: 2222, redes: ['192.0.2.0/24'] });
		expect(sin.salida.destinos).toEqual(['ghcr.io:443', 'siem.example.com:6514']);
		expect(sin.salida.comprobar).toEqual(['ghcr.io:443']);
		const con = await a.paraElActualizador({
			REGISTRO: 'ghcr.io',
			HTTPS_PROXY: 'http://u:p@proxy.corp:3128'
		});
		expect(con.salida.destinos).toEqual(['proxy.corp:3128', 'siem.example.com:6514']);
		expect(con.salida.comprobar).toEqual(['proxy.corp:3128']);
		expect(con.consola.estado).toBe('pendiente');
	});

	it('los cambios de la máquina van a la auditoría como integridad.anfitrion', async () => {
		const hechos = (huellas: string[], desfasada = false) =>
			a.leerHechos({
				docker: { version: '28.5.0', fijada: '29.9.1', desfasada },
				maquina: {
					ssh: {
						activo: false,
						usuarios: [{ usuario: 'root', uid: 0, claves: huellas.length, huellas }]
					},
					auditd: { estado: 'puesta' }
				}
			})!;
		const k1 = 'SHA256:' + 'A'.repeat(43);
		const k2 = 'SHA256:' + 'B'.repeat(43);
		expect(await a.recibirHechos(hechos([k1]))).toEqual(['host change: SSH access found']);
		expect(await a.recibirHechos(hechos([k1]))).toEqual([]);
		expect(await a.recibirHechos(hechos([k1, k2], true))).toEqual([
			'host change: SSH keys',
			'host change: Docker older than the signed version'
		]);
		expect(await a.avisoAnfitrion()).toMatchObject({
			docker: { version: '28.5.0', fijada: '29.9.1' }
		});
		const f = await filas();
		expect(f.every((x) => x.accion.startsWith(a.PREFIJO_CAMBIO))).toBe(true);
		expect(f[1].detalle).toMatchObject({ nuevas: [`root ${k2}`], quitadas: [] });
	});

	it('el cortafuegos: solo apunta lo que cambia, y lo resume en el latido', async () => {
		expect(await a.recibirEstricto({ estado: 'inventado' })).toBe(false);
		const h = 'a'.repeat(64);
		expect(await a.recibirEstricto({ estado: 'aplicada', detalle: 'x', huella: h })).toBe(true);
		await a.recibirEstricto({ estado: 'aplicada', detalle: 'x', huella: h });
		await a.recibirEstricto({ estado: 'revertida', detalle: 'no contact' });
		expect((await filas()).map((x) => x.accion)).toEqual([
			'host firewall aplicada',
			'host firewall revertida'
		]);
		await a.encenderEstricto(QUIEN);
		expect((await a.avisoAnfitrion())?.estricto).toContain('revertida');
		await a.recibirHechos(a.leerHechos({ docker: { version: '29.9.1', desfasada: false } })!);
		expect((await a.anfitrionParaLatido()).anfitrion).toMatchObject({
			estricto: 'revertida',
			ssh: { activo: false, usuarios: 0, claves: 0 },
			docker: { version: '29.9.1', desfasada: false }
		});
	});

	it('los eventos de auditd: uno por fila, los de más contados', async () => {
		expect(await a.recibirAuditd({ nada: 1 })).toBeNull();
		const n = await a.recibirAuditd({
			eventos: [
				{
					categoria: 'sudoers',
					usuario: 'kino',
					ruta: '/etc/sudoers',
					programa: '/usr/bin/vim',
					exito: 'yes'
				},
				{ categoria: 'inventada' },
				{ categoria: 'nodo', ruta: '/opt/sugardaddy/.env' }
			],
			omitidos: 7
		});
		expect(n).toBe(3);
		const f = await filas();
		expect(f.map((x) => [x.quien, x.accion])).toEqual([
			['node machine (kino)', 'host change: sudoers'],
			['node machine', 'host change: node folder'],
			['node machine', 'host change: audit events not sent (too many in one round)']
		]);
		expect(f.every((x) => x.accion.startsWith(a.PREFIJO_CAMBIO))).toBe(true);
	});
	it('un sensor remoto: el mismo ajuste, sin consola ni salidas, y su estado aparte', async () => {
		await db.insert(s.sensores).values({
			id: SENSOR.id,
			nombre: SENSOR.nombre,
			remoto: true,
			claveHash: 'zz-anfitrion-remoto'
		});
		const amb = a.ambitoSensor(SENSOR);
		/* De serie, apagado; el appliance que cuenta el sensor lo enciende solo para él. */
		expect((await a.paraElSensor(SENSOR)).estricto).toBe(false);
		await a.recibirHechos(
			a.leerHechos({ docker: { desfasada: false }, maquina: { appliance: true } })!,
			amb
		);
		expect((await a.paraElSensor(SENSOR)).estricto).toBe(true);
		expect((await a.estrictoEfectivo()).activo).toBe(false);
		await a.guardarAjusteAnfitrion(QUIEN, {
			estricto: true,
			sshPuerto: 2222,
			sshRedes: ['10.20.0.0/16'],
			restringida: true,
			destinos: ['repo.empresa.es:443']
		});
		const r = await a.paraElSensor(SENSOR);
		expect(r).toMatchObject({
			estricto: true,
			emergencia: false,
			consola: { estado: 'abierta', redes: [] },
			ssh: { puerto: 2222, redes: ['10.20.0.0/16'] },
			salida: { restringida: true, comprobar: [] }
		});
		expect(r.salida.destinos).toEqual([...a.DESTINOS_APPLIANCE, 'repo.empresa.es:443']);
		/* Su cortafuegos y su auditd, apuntados con su nombre; el del nodo, intacto. */
		expect(
			await a.recibirEstricto({ estado: 'aplicada', detalle: 'x', huella: 'b'.repeat(64) }, amb)
		).toBe(true);
		expect(await a.estadoEstricto()).toBeNull();
		expect((await a.estadoEstricto(amb))?.estado).toBe('aplicada');
		await a.recibirAuditd({ eventos: [{ categoria: 'ssh', usuario: 'ana' }] }, amb);
		const f = await db
			.select()
			.from(s.auditoria)
			.where(
				and(gt(s.auditoria.id, desde), like(s.auditoria.quien, `sensor ${SENSOR.nombre} machine%`))
			)
			.orderBy(s.auditoria.id);
		expect(f.map((x) => [x.quien, x.accion])).toEqual([
			[`sensor ${SENSOR.nombre} machine`, 'host firewall aplicada'],
			[`sensor ${SENSOR.nombre} machine (ana)`, 'host change: SSH configuration or keys']
		]);
		expect(f.every((x) => (x.detalle as { sensor?: string }).sensor === SENSOR.id)).toBe(true);
		const m = (await a.maquinasSensores()).find((x) => x.id === SENSOR.id);
		expect(m).toMatchObject({
			estado: { estado: 'aplicada' },
			viejo: false,
			hechos: { appliance: true }
		});
	});
});
