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
const { hashCodigoRecuperacion } = await import('@sugardaddy/canal');

const P = 'zz-panrec';
const clave = 'contraseña nueva bien larga';
let id = '';

async function limpiar() {
	await db.delete(s.usuariosLocales).where(like(s.usuariosLocales.usuario, `${P}%`));
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

	it('lo guarda una sola vez aunque llegue en cada latido, y se canjea', async () => {
		const r = {
			id: `${P}-1`,
			usuario: `${P}-ADMIN`,
			codigoHash: hashCodigoRecuperacion('424242'),
			caduca: enUnaHora()
		};
		await canal.guardarRecuperacionPanel(r);
		await canal.guardarRecuperacionPanel(r);
		const filas = await db
			.select()
			.from(s.recuperacionesClave)
			.where(eq(s.recuperacionesClave.usuarioId, id));
		expect(filas).toHaveLength(1);
		expect(filas[0].origen).toBe('panel');

		expect((await rec.canjearCodigo(`${P}-admin`, '424242', clave)).ok).toBe(true);
		expect((await local.verificar(`${P}-admin`, clave)).ok).toBe(true);
		/* Ya canjeado: aunque el estado lo siga trayendo, no se vuelve a abrir. */
		await canal.guardarRecuperacionPanel(r);
		expect((await rec.canjearCodigo(`${P}-admin`, '424242', clave)).ok).toBe(false);
	});

	it('ignora lo caducado, el hash raro y el usuario que no existe', async () => {
		const antes = (await db.select().from(s.recuperacionesClave)).length;
		await canal.guardarRecuperacionPanel({
			id: `${P}-2`,
			usuario: `${P}-admin`,
			codigoHash: hashCodigoRecuperacion('111111'),
			caduca: new Date(Date.now() - 1000).toISOString()
		});
		await canal.guardarRecuperacionPanel({
			id: `${P}-3`,
			usuario: `${P}-admin`,
			codigoHash: 'texto cualquiera',
			caduca: enUnaHora()
		});
		await canal.guardarRecuperacionPanel({
			id: `${P}-4`,
			usuario: `${P}-nadie`,
			codigoHash: hashCodigoRecuperacion('111111'),
			caduca: enUnaHora()
		});
		await canal.guardarRecuperacionPanel(null);
		expect((await db.select().from(s.recuperacionesClave)).length).toBe(antes);
	});
});
