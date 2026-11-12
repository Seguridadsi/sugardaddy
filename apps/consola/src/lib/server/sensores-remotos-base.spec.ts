/*
 * El alta de un sensor en otra máquina, en la base de verdad:
 *
 *  - Una máquina que no resuelve el nombre de la consola (un sensor en internet):
 *    con «Address of this console as seen from that machine», la línea baja el
 *    instalador con `curl --resolve` y el instalador deja la resolución fija en
 *    el .env del sensor (CONSOLA_FIJA), que su compose lleva a extra_hosts. Sin
 *    ella, todo sigue como antes.
 *  - Quitar un sensor que ya entregó eventos lo deja retirado, a la vista y sin
 *    forma de volver a entrar; darlo de alta otra vez con el mismo identificador
 *    lo reactiva con su historia.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));
/* La raíz de la consola: una cualquiera, para que la línea lleve --cacert. */
vi.mock('./ca-nodo', () => ({ raicesParaSensores: async () => 'RAIZ-DE-PRUEBA\n' }));

/* El compose del sensor remoto tal como viaja firmado con la versión. */
const COMPOSE = readFileSync(
	join(import.meta.dirname, '../../../../../despliegue/sensor-remoto/compose.yml'),
	'utf8'
);
const release = (compose: string) => ({
	descarga: { registro: 'registro.prueba', usuario: 'nodo', token: 'credencial-del-registro' },
	firmada: { release: '{}', firma: 'x' },
	release: {
		version: '9.9.9',
		servicios: { sensor: 'registro.prueba/sensor@sha256:aa' },
		actualizador: 'registro.prueba/actualizador@sha256:bb',
		catalogo: null,
		sensorRemoto: { ficheros: { 'compose.yml': compose }, entorno: {} }
	}
});
let composeServido = COMPOSE;
vi.mock('./canal', () => ({
	credencialSensorRemoto: async () => release(composeServido)
}));

describe.skipIf(!process.env.DATABASE_URL)('sensores en otras máquinas', async () => {
	const { db, schema: s } = await import('./db');
	const { eq, inArray, like } = await import('drizzle-orm');
	const r = await import('./sensores-remotos');
	const g = await import('./gestion');
	const a = await import('./acceso');

	const QUIEN = 'zz-remoto@prueba';
	const P = 'zz-rem';
	const CLAVES = ['acceso-consola', 'acceso-consola-cortafuegos'];
	const NOMBRE = 'gestion.cliente.test';

	const limpiar = async () => {
		await db.delete(s.eventos).where(like(s.eventos.sensor, `${P}%`));
		await db.delete(s.destinos).where(like(s.destinos.id, `${P}%`));
		await db.delete(s.instaladoresSensor).where(like(s.instaladoresSensor.sensor, `${P}%`));
		await db.delete(s.sensores).where(like(s.sensores.id, `${P}%`));
		await db.delete(s.ajustes).where(inArray(s.ajustes.clave, CLAVES));
		await db.delete(s.auditoria).where(inArray(s.auditoria.quien, [QUIEN, 'installer']));
		a._olvidarAcceso();
		composeServido = COMPOSE;
		process.env.ORIGIN = `https://${NOMBRE}`;
		delete process.env.CONSOLA_URL;
		delete process.env.CONSOLA_ACCESO;
		delete process.env.TLS_MODO;
	};
	beforeEach(limpiar);
	afterAll(async () => {
		await limpiar();
		delete process.env.ORIGIN;
	});

	const fila = async (id: string) =>
		(await db.select().from(s.sensores).where(eq(s.sensores.id, id)))[0];
	const codigoDe = (linea: string) => /\/instalar-sensor\/([A-Za-z0-9_-]{32})/.exec(linea)![1];
	/* El .env que el instalador escribe en la máquina del sensor. */
	const envDe = (script: string) =>
		Buffer.from(/echo '([A-Za-z0-9+/=]+)' \| base64 -d > \.env/.exec(script)![1], 'base64')
			.toString()
			.split('\n');
	const conHistoria = (sensor: string, n = 1) =>
		db.insert(s.eventos).values({
			id: `2b0e0000-0000-4000-8000-0000000054a${n}`,
			sensor,
			linea: '{}',
			hash: `${sensor}-hash-${n}`,
			cuando: new Date(),
			trampa: `${P}-t-vieja`,
			modulo: 'cowrie',
			tipo: 'contenedor',
			accion: 'conexion',
			severidad: 'media',
			conexionEstablecida: true
		});

	describe('la consola vista desde la máquina del sensor', () => {
		it('solo vale una IP, y sobra si la consola ya se da por una IP', () => {
			expect(r.ipDeConsola(' 203.0.113.7 ', `https://${NOMBRE}`)).toBe('203.0.113.7');
			expect(r.ipDeConsola('2001:DB8::7', `https://${NOMBRE}`)).toBe('2001:db8::7');
			expect(r.ipDeConsola('', `https://${NOMBRE}`)).toBeNull();
			expect(r.ipDeConsola(undefined, `https://${NOMBRE}`)).toBeNull();
			expect(() => r.ipDeConsola('consola.otra.test', `https://${NOMBRE}`)).toThrow(r.ErrorCliente);
			expect(() => r.ipDeConsola('203.0.113.7; rm -rf /', `https://${NOMBRE}`)).toThrow(
				r.ErrorCliente
			);
			expect(r.ipDeConsola('203.0.113.7', 'https://10.0.0.5')).toBeNull();
		});

		it('se propone la dirección por la que entra quien da el alta, si entra por IP', () => {
			expect(r.ipDeConsolaPropuesta('203.0.113.7', `https://${NOMBRE}`)).toBe('203.0.113.7');
			/* Por nombre: lo normal es que la otra máquina también lo resuelva. */
			expect(r.ipDeConsolaPropuesta(NOMBRE, `https://${NOMBRE}`)).toBeNull();
			expect(r.ipDeConsolaPropuesta('10.0.0.5', 'https://10.0.0.5')).toBeNull();
			expect(r.ipDeConsolaPropuesta('203.0.113.7', null)).toBeNull();
			/* Desde la propia máquina de la consola, la del bucle local no le vale a otra. */
			expect(r.ipDeConsolaPropuesta('127.0.0.1', `https://${NOMBRE}`)).toBeNull();
			expect(r.ipDeConsolaPropuesta('[::1]', `https://${NOMBRE}`)).toBeNull();
			expect(r.consolaParaAlta('203.0.113.7')).toEqual({
				nombre: NOMBRE,
				propuesta: '203.0.113.7'
			});
			process.env.ORIGIN = 'https://10.0.0.5';
			expect(r.consolaParaAlta('203.0.113.7')).toEqual({ nombre: null, propuesta: null });
		});

		it('curl resuelve el nombre en esa IP, con el puerto de la consola', () => {
			expect(r.resolverConsola(`https://${NOMBRE}`, '203.0.113.7')).toBe(
				`--resolve ${NOMBRE}:443:203.0.113.7 `
			);
			expect(r.resolverConsola(`https://${NOMBRE}:8443`, '203.0.113.7')).toBe(
				`--resolve ${NOMBRE}:8443:203.0.113.7 `
			);
			expect(r.resolverConsola(`https://${NOMBRE}`, null)).toBe('');
		});
	});

	describe('el alta con la IP de la consola', () => {
		it('la línea y el instalador fijan la resolución, sin tocar la máquina', async () => {
			const id = `${P}-internet`;
			const linea = await r.altaSensorRemoto(
				QUIEN,
				{ id, nombre: 'Sensor en internet' },
				undefined,
				'',
				'203.0.113.7'
			);
			/* El certificado se sigue comprobando contra el nombre: la URL no cambia. */
			expect(linea).toContain(`--resolve ${NOMBRE}:443:203.0.113.7 --cacert `);
			expect(linea).toContain(` https://${NOMBRE}/instalar-sensor/`);
			expect((await fila(id)).consolaIp).toBe('203.0.113.7');

			const script = (await r.scriptSensorRemoto(codigoDe(linea!)))!;
			expect(envDe(script)).toContain(`CONSOLA_FIJA=${NOMBRE}:203.0.113.7`);
			expect(envDe(script)).toContain(`CONSOLA_URL=https://${NOMBRE}`);
			/* No se le pide a la máquina que resuelva el nombre: no puede. */
			expect(script).not.toContain('getent hosts');
			/* Lo que el propio instalador le cuenta a la consola va por la misma IP. */
			expect(script).toMatch(
				new RegExp(
					`curl -fsS --resolve ${NOMBRE}:443:203\\.0\\.113\\.7 --cacert ca-consola\\.crt .*https://${NOMBRE}/api/sensor/red`
				)
			);
			/* El compose que acompaña lleva esa variable a /etc/hosts de los dos contenedores. */
			expect(COMPOSE.match(/extra_hosts:\n\s+- \$\{CONSOLA_FIJA:-[^}]+\}/g)).toHaveLength(2);
			/* Y sigue siendo un script válido. */
			execFileSync('bash', ['-n'], { input: script });
		});

		it('sin ella, todo como antes: la máquina tiene que resolver el nombre', async () => {
			const id = `${P}-lan`;
			const linea = await r.altaSensorRemoto(QUIEN, { id, nombre: 'Sensor de la sede' });
			expect(linea).not.toContain('--resolve');
			expect(linea).not.toContain('--retry');
			const script = (await r.scriptSensorRemoto(codigoDe(linea!)))!;
			expect(envDe(script).some((l) => l.startsWith('CONSOLA_FIJA='))).toBe(false);
			expect(script).toContain(`getent hosts ${NOMBRE}`);
			expect(script).not.toContain('--resolve');
			execFileSync('bash', ['-n'], { input: script });
		});

		it('lo que no es una IP no da de alta nada', async () => {
			const id = `${P}-mal`;
			await expect(
				r.altaSensorRemoto(QUIEN, { id, nombre: 'Mal' }, undefined, '', 'gestion.otra.test')
			).rejects.toBeInstanceOf(r.ErrorCliente);
			expect(await fila(id)).toBeUndefined();
		});

		it('una línea nueva conserva la IP indicada, y se puede cambiar o quitar', async () => {
			const id = `${P}-otra`;
			await r.altaSensorRemoto(QUIEN, { id, nombre: 'Otra' }, undefined, '', '203.0.113.7');
			expect(await r.lineaSensorRemoto(QUIEN, id)).toContain(':443:203.0.113.7 ');
			expect(await r.lineaSensorRemoto(QUIEN, id, '', '198.51.100.9')).toContain(
				':443:198.51.100.9 '
			);
			expect((await fila(id)).consolaIp).toBe('198.51.100.9');
			expect(await r.lineaSensorRemoto(QUIEN, id, '', '')).not.toContain('--resolve');
			expect((await fila(id)).consolaIp).toBeNull();
		});

		it('un compose que no sabe fijarla no instala a medias: lo dice', async () => {
			const id = `${P}-viejo`;
			const linea = await r.altaSensorRemoto(
				QUIEN,
				{ id, nombre: 'Viejo' },
				undefined,
				'',
				'203.0.113.7'
			);
			composeServido = COMPOSE.replaceAll('CONSOLA_FIJA', 'OTRA_COSA');
			await expect(r.scriptSensorRemoto(codigoDe(linea!))).rejects.toBeInstanceOf(r.ErrorCliente);
		});

		it('con el acceso limitado, la línea espera a que el cortafuegos deje pasar a la máquina', async () => {
			await a.guardarAcceso(QUIEN, [{ red: '10.0.9.9' }], '10.0.9.9', false);
			const id = `${P}-limitado`;
			const linea = await r.altaSensorRemoto(
				QUIEN,
				{ id, nombre: 'Limitado' },
				undefined,
				'198.51.100.20',
				'203.0.113.7'
			);
			expect(linea).toContain('--retry 8 --retry-delay 10 --retry-connrefused --resolve ');
			expect((await a.leerAcceso()).entradas.map((e) => e.red)).toContain('198.51.100.20');
		});
	});

	describe('quitar un sensor con historia y volver a darlo de alta', () => {
		it('queda retirado, a la vista, sin token ni líneas pendientes', async () => {
			const id = `${P}-historia`;
			const linea = await r.altaSensorRemoto(QUIEN, { id, nombre: 'Con historia' });
			await r.scriptSensorRemoto(codigoDe(linea!));
			/* Otra línea sin usar: con ella volvería a entrar sin que nadie lo diera de alta. */
			await r.lineaSensorRemoto(QUIEN, id);
			await db.update(s.sensores).set({ ultimoLatido: new Date() }).where(eq(s.sensores.id, id));
			await conHistoria(id);
			const antes = await fila(id);
			expect(antes.claveHashSiguiente).not.toBeNull();

			expect(await g.retirarSensor(QUIEN, id)).toBe('desactivado');
			const f = await fila(id);
			expect(f.retirado).toBeInstanceOf(Date);
			expect(f.claveHash).not.toBe(antes.claveHash);
			expect(f.claveHashSiguiente).toBeNull();
			expect(
				await db.select().from(s.instaladoresSensor).where(eq(s.instaladoresSensor.sensor, id))
			).toHaveLength(0);

			/* En Sensores: retirado y no «en línea», aunque latiera hace un momento; al final. */
			const lista = await g.sensores();
			const x = lista.find((y) => y.id === id)!;
			expect(x.retirado).toEqual(f.retirado!.toISOString());
			expect(x.vivo).toBe(false);
			await r.altaSensorRemoto(QUIEN, { id: `${P}-nuevo`, nombre: 'Nuevo' });
			const orden = (await g.sensores()).map((y) => y.id);
			expect(orden.indexOf(`${P}-nuevo`)).toBeLessThan(orden.indexOf(id));

			/* No cuenta como sensor remoto del que esperar su dirección, ni se reinstala desde su fila. */
			expect((await a.sensoresSinDireccion()).map((y) => y.id)).not.toContain(id);
			await expect(r.lineaSensorRemoto(QUIEN, id)).rejects.toBeInstanceOf(r.ErrorCliente);
			/* Quitarlo otra vez no cambia nada. */
			expect(await g.retirarSensor(QUIEN, id)).toBe('desactivado');
			expect((await fila(id)).retirado).toEqual(f.retirado);
		});

		it('darlo de alta con el mismo identificador lo reactiva, con su historia', async () => {
			const id = `${P}-vuelve`;
			await r.altaSensorRemoto(QUIEN, { id, nombre: 'Antes', entorno: 'dentro' });
			await conHistoria(id, 2);
			await g.retirarSensor(QUIEN, id);

			const linea = await r.altaSensorRemoto(
				QUIEN,
				{ id, nombre: 'Después' },
				undefined,
				'',
				'203.0.113.7'
			);
			expect(linea).toContain(`--resolve ${NOMBRE}:443:203.0.113.7 `);
			const f = await fila(id);
			expect(f).toMatchObject({
				retirado: null,
				nombre: 'Después',
				entorno: 'dentro',
				consolaIp: '203.0.113.7',
				remoto: true
			});
			/* Su historia sigue siendo suya, y su destino también. */
			expect(await db.select().from(s.eventos).where(eq(s.eventos.sensor, id))).toHaveLength(1);
			expect(
				await db.select({ id: s.destinos.id }).from(s.destinos).where(eq(s.destinos.sensor, id))
			).toHaveLength(1);
			expect((await g.sensores()).find((y) => y.id === id)!.retirado).toBeNull();
			/* Su instalador le entrega un token nuevo, como en cualquier alta. */
			const script = (await r.scriptSensorRemoto(codigoDe(linea!)))!;
			expect(envDe(script).some((l) => l.startsWith('SUGARDADDY_TOKEN='))).toBe(true);
			expect((await fila(id)).claveHashSiguiente).not.toBeNull();
			const acciones = (
				await db.select().from(s.auditoria).where(eq(s.auditoria.quien, QUIEN))
			).map((x) => x.accion);
			expect(acciones).toContain('sensor re-enrolled');
		});

		it('una línea de antes de quitarlo ya no instala nada', async () => {
			const id = `${P}-linea-vieja`;
			const linea = await r.altaSensorRemoto(QUIEN, { id, nombre: 'Línea vieja' });
			await conHistoria(id, 3);
			await g.retirarSensor(QUIEN, id);
			expect(await r.scriptSensorRemoto(codigoDe(linea!))).toBeNull();
		});

		it('uno activo con ese identificador sigue sin poder darse de alta dos veces', async () => {
			const id = `${P}-doble`;
			await r.altaSensorRemoto(QUIEN, { id, nombre: 'Uno' });
			expect(await r.altaSensorRemoto(QUIEN, { id, nombre: 'Dos' })).toBeNull();
			expect((await fila(id)).nombre).toBe('Uno');
		});

		it('uno sin historia se borra, y el identificador queda libre', async () => {
			const id = `${P}-limpio`;
			await r.altaSensorRemoto(QUIEN, { id, nombre: 'Limpio' });
			expect(await g.retirarSensor(QUIEN, id)).toBe('retirado');
			expect(await fila(id)).toBeUndefined();
			expect(await r.altaSensorRemoto(QUIEN, { id, nombre: 'Limpio otra vez' })).toContain(
				'/instalar-sensor/'
			);
		});

		it('uno retirado que no era remoto no se reactiva como remoto', async () => {
			const id = `${P}-local`;
			await g.crearSensor(QUIEN, { id, nombre: 'Local', red: null, vlan: null });
			await conHistoria(id, 4);
			await g.retirarSensor(QUIEN, id);
			expect(await r.altaSensorRemoto(QUIEN, { id, nombre: 'Local' })).toBeNull();
			expect((await fila(id)).retirado).toBeInstanceOf(Date);
		});
	});
});
