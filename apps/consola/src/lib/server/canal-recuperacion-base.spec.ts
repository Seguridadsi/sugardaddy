/*
 * El código de recuperación que SeguridadSI manda desde su panel: el nodo lo
 * recibe (solo el hash) en el estado firmado, lo guarda una vez para ese usuario
 * local y se canjea como uno pedido desde la entrada. DATABASE_URL del entorno;
 * si no hay, se salta. Prefijo zz-panrec, se limpia al final.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const hayBase = !!process.env.DATABASE_URL;
process.env.LOGIN_LOCAL = '1';
vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

const { db, schema: s } = hayBase ? await import('./db') : ({} as never);
const canal = hayBase ? await import('./canal') : ({} as never);
const local = hayBase ? await import('./auth/local') : ({} as never);
const rec = hayBase ? await import('./auth/recuperar') : ({} as never);
const { eq, like } = await import('drizzle-orm');
const { firmanteDePrivada, firmarCon, generarClaves, hashCodigoRecuperacion } =
	await import('@sugardaddy/canal');

/* La clave de publicación del nodo de prueba: firma las órdenes (frenos-del-nodo.md). */
const publicacion = generarClaves();
process.env.PUBLICACION_CLAVE_PUBLICA = publicacion.publica;
process.env.PUBLICACION_CLAVES = '';
const CLIENTE = 'zz-panrec-cliente';
type Plana = { id: string; usuario: string; codigoHash: string; caduca: string };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/* La orden firmada, como la deja herramientas/firmar-orden.sh; `con` otra clave para probar. */
const firmada = (r: Plana, cliente = CLIENTE, con = publicacion.privada) => {
	const orden = JSON.stringify({
		tipo: 'recuperacion',
		version: 1,
		cliente,
		...r,
		emitida: new Date().toISOString()
	});
	return { orden, ...firmarCon(orden, firmanteDePrivada(con)) };
};
const guardar = (r: Plana) => canal.guardarRecuperacionPanel(r, firmada(r), CLIENTE);

const P = 'zz-panrec';
const clave = 'contraseña nueva bien larga';
let id = '';

async function limpiar() {
	await db.delete(s.usuariosLocales).where(like(s.usuariosLocales.usuario, `${P}%`));
	await db.delete(s.ajustes).where(eq(s.ajustes.clave, 'recuperacion-panel'));
}

const enUnaHora = () => new Date(Date.now() + 3600_000).toISOString();

describe.skipIf(!hayBase)('código de recuperación mandado desde el panel', () => {
	beforeAll(async () => {
		await limpiar();
		const c = await local.crear('tester', {
			usuario: `${P}-admin`,
			nombre: 'Admin',
			correo: 'admin@ejemplo.com',
			roles: ['admin'],
			clave: 'contraseña vieja bien larga'
		});
		id = c.ok ? c.id : '';
	});
	afterAll(limpiar);

	it('sin permitirlo en Ajustes no se guarda nada (SUP-12)', async () => {
		expect(await canal.recuperacionPanelActiva()).toBe(false);
		await guardar({
			id: uuid(0),
			usuario: `${P}-admin`,
			codigoHash: hashCodigoRecuperacion('999999'),
			caduca: enUnaHora()
		});
		const filas = await db
			.select()
			.from(s.recuperacionesClave)
			.where(eq(s.recuperacionesClave.usuarioId, id));
		expect(filas).toHaveLength(0);
		expect((await rec.canjearCodigo(`${P}-admin`, '999999', clave)).ok).toBe(false);
		await canal.guardarRecuperacionPanelActiva('tester', true);
		expect(await canal.recuperacionPanelActiva()).toBe(true);
	});

	it('lo guarda una sola vez aunque llegue en cada latido, y se canjea', async () => {
		const r = {
			id: uuid(1),
			usuario: `${P}-admin`,
			codigoHash: hashCodigoRecuperacion('424242'),
			caduca: enUnaHora()
		};
		await guardar(r);
		await guardar(r);
		const filas = await db
			.select()
			.from(s.recuperacionesClave)
			.where(eq(s.recuperacionesClave.usuarioId, id));
		expect(filas).toHaveLength(1);
		expect(filas[0].origen).toBe('panel');

		expect((await rec.canjearCodigo(`${P}-admin`, '424242', clave)).ok).toBe(true);
		expect((await local.verificar(`${P}-admin`, clave)).ok).toBe(true);
		/* Ya canjeado: aunque el estado lo siga trayendo, no se vuelve a abrir. */
		await guardar(r);
		expect((await rec.canjearCodigo(`${P}-admin`, '424242', clave)).ok).toBe(false);
	});

	it('ignora lo caducado, el hash raro y el usuario que no existe', async () => {
		const antes = (await db.select().from(s.recuperacionesClave)).length;
		await guardar({
			id: uuid(2),
			usuario: `${P}-admin`,
			codigoHash: hashCodigoRecuperacion('111111'),
			caduca: new Date(Date.now() - 1000).toISOString()
		});
		await guardar({
			id: uuid(3),
			usuario: `${P}-admin`,
			codigoHash: 'texto cualquiera',
			caduca: enUnaHora()
		});
		await guardar({
			id: uuid(4),
			usuario: `${P}-nadie`,
			codigoHash: hashCodigoRecuperacion('111111'),
			caduca: enUnaHora()
		});
		await canal.guardarRecuperacionPanel(null);
		expect((await db.select().from(s.recuperacionesClave)).length).toBe(antes);
	});

	describe('sin la firma de la clave de publicación no vale (frenos del nodo)', () => {
		const r = () => ({
			id: uuid(9),
			usuario: `${P}-admin`,
			codigoHash: hashCodigoRecuperacion('777777'),
			caduca: enUnaHora()
		});
		const nada = async () =>
			expect((await rec.canjearCodigo(`${P}-admin`, '777777', clave)).ok).toBe(false);

		it('la recuperación sin firmar, solo con la clave del panel, se ignora', async () => {
			await canal.guardarRecuperacionPanel(r());
			await nada();
		});

		it('firmada con otra clave (la del panel), no vale', async () => {
			await canal.guardarRecuperacionPanel(
				r(),
				firmada(r(), CLIENTE, generarClaves().privada),
				CLIENTE
			);
			await nada();
		});

		it('firmada para otro cliente, no vale', async () => {
			await canal.guardarRecuperacionPanel(r(), firmada(r(), 'otro-cliente'), CLIENTE);
			await nada();
		});
	});
});
