/*
 * El login local contra una base de datos de verdad: alta, entrada, freno a la
 * fuerza bruta, restablecimiento, cambio por reto y las guardas de «último
 * administrador». DATABASE_URL (del entorno o de .env); si no hay, se salta.
 * Todo lleva el prefijo zz-auth y se limpia al final.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

try {
	for (const l of readFileSync('.env', 'utf8').split('\n')) {
		const m = l.match(/^([A-Z_]+)=(.*)$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
	}
} catch {
	/* Sin .env: vale el DATABASE_URL del entorno, si lo hay. */
}
const hayBase = !!process.env.DATABASE_URL;

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

const { db, schema: s } = hayBase ? await import('../db') : ({} as never);
const local = hayBase ? await import('./local') : ({} as never);
const { like } = await import('drizzle-orm');

const P = 'zz-auth';
const clave1 = 'contraseña muy larga uno';
const clave2 = 'otra contraseña larga dos';

async function limpiar() {
	await db.delete(s.usuariosLocales).where(like(s.usuariosLocales.usuario, `${P}%`));
}

describe.skipIf(!hayBase)('login local contra base de datos', () => {
	beforeAll(limpiar);
	afterAll(async () => {
		if (!process.env.CONSERVAR) await limpiar();
	});

	it('alta: crea, rechaza el duplicado, el usuario inválido y la clave corta', async () => {
		const r = await local.crear('tester', {
			usuario: `${P}-ana`,
			nombre: 'Ana',
			correo: 'ana@local',
			roles: ['operador'],
			clave: clave1
		});
		expect(r.ok).toBe(true);

		expect(
			(
				await local.crear('tester', {
					usuario: `${P}-ANA`,
					nombre: '',
					correo: '',
					roles: ['operador'],
					clave: clave1
				})
			).ok
		).toBe(false); // duplicado (se normaliza a minúsculas)
		expect(
			(
				await local.crear('tester', {
					usuario: 'x',
					nombre: '',
					correo: '',
					roles: ['operador'],
					clave: clave1
				})
			).ok
		).toBe(false); // usuario inválido
		expect(
			(
				await local.crear('tester', {
					usuario: `${P}-corta`,
					nombre: '',
					correo: '',
					roles: ['operador'],
					clave: 'corta'
				})
			).ok
		).toBe(false); // clave corta
	});

	it('entrada: acierta (y pide cambiar la primera vez) y falla con clave mala', async () => {
		const ok = await local.verificar(`${P}-ana`, clave1);
		expect(ok.ok).toBe(true);
		if (ok.ok) {
			expect(ok.debeCambiar).toBe(true);
			expect(ok.identidad.oid.startsWith('local:')).toBe(true);
			expect(ok.identidad.roles).toEqual(['operador']);
			expect(ok.identidad.soporte).toBe(false);
		}
		const mal = await local.verificar(`${P}-ana`, 'lo que sea');
		expect(mal.ok).toBe(false);
		if (!mal.ok) expect(mal.motivo).toBe('credenciales');

		const noExiste = await local.verificar(`${P}-nadie`, 'x');
		expect(noExiste.ok).toBe(false);
	});

	it('freno a la fuerza bruta: tras varios fallos bloquea aunque la clave sea correcta', async () => {
		await local.crear('tester', {
			usuario: `${P}-bruto`,
			nombre: 'B',
			correo: 'b@local',
			roles: ['lector'],
			clave: clave1
		});
		for (let i = 0; i < 5; i++) await local.verificar(`${P}-bruto`, 'mala');
		const r = await local.verificar(`${P}-bruto`, clave1); // correcta, pero ya bloqueado
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.motivo).toBe('bloqueado');
	});

	it('restablecer: deja entrar con la nueva, pide cambiarla y quita el bloqueo', async () => {
		const [u] = await db
			.select({ id: s.usuariosLocales.id })
			.from(s.usuariosLocales)
			.where(like(s.usuariosLocales.usuario, `${P}-bruto`));
		expect((await local.restablecer('tester', u.id, clave2)).ok).toBe(true);
		const r = await local.verificar(`${P}-bruto`, clave2); // ya no bloqueado
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.debeCambiar).toBe(true);
	});

	it('cambio por reto: cambia la clave y deja de pedir el cambio', async () => {
		const [u] = await db
			.select({ id: s.usuariosLocales.id })
			.from(s.usuariosLocales)
			.where(like(s.usuariosLocales.usuario, `${P}-ana`));
		const reto = local.abrirRetoCambio(u.id);
		expect(local.retoCambio(reto)).toBe(u.id);
		const r = await local.cambiarClave(u.id, clave2);
		expect(r.ok).toBe(true);
		const entra = await local.verificar(`${P}-ana`, clave2);
		expect(entra.ok).toBe(true);
		if (entra.ok) expect(entra.debeCambiar).toBe(false);
	});

	it('guardas de administrador: no deja quedarse sin ningún admin local', async () => {
		await local.crear('tester', {
			usuario: `${P}-jefe`,
			nombre: 'Jefe',
			correo: 'j@local',
			roles: ['admin'],
			clave: clave1
		});
		const [jefe] = await db
			.select({ id: s.usuariosLocales.id })
			.from(s.usuariosLocales)
			.where(like(s.usuariosLocales.usuario, `${P}-jefe`));

		/* Es el único admin: ni quitarle admin ni retirarlo. */
		expect((await local.fijarRoles('tester', jefe.id, ['operador'])).ok).toBe(false);
		expect((await local.retirar('tester', jefe.id)).ok).toBe(false);

		/* Con un segundo admin, ya sí se puede degradar al primero. */
		await local.crear('tester', {
			usuario: `${P}-jefe2`,
			nombre: 'Jefa dos',
			correo: 'j2@local',
			roles: ['admin'],
			clave: clave1
		});
		expect((await local.fijarRoles('tester', jefe.id, ['operador'])).ok).toBe(true);
	});

	it('autogestión: el usuario cambia su propio nombre y su propia contraseña', async () => {
		const c = await local.crear('tester', {
			usuario: `${P}-yo`,
			nombre: 'Yo',
			correo: 'yo@local',
			roles: ['operador'],
			clave: clave1
		});
		expect(c.ok).toBe(true);
		const id = c.ok ? c.id : '';

		/* Nombre: cambia (y recorta); vacío se rechaza. */
		const n = await local.cambiarNombrePropio('yo@local', id, '  Yo Mismo  ');
		expect(n.ok).toBe(true);
		if (n.ok) expect(n.nombre).toBe('Yo Mismo');
		expect((await local.cambiarNombrePropio('yo@local', id, '   ')).ok).toBe(false);

		/* Contraseña: rechaza la actual incorrecta, la corta y la igual a la actual. */
		expect((await local.cambiarClavePropia('yo@local', id, 'no es la actual larga', clave2)).ok).toBe(
			false
		);
		expect((await local.cambiarClavePropia('yo@local', id, clave1, 'corta')).ok).toBe(false);
		expect((await local.cambiarClavePropia('yo@local', id, clave1, clave1)).ok).toBe(false);

		/* Con la actual correcta, cambia: la nueva entra y la vieja ya no. */
		expect((await local.cambiarClavePropia('yo@local', id, clave1, clave2)).ok).toBe(true);
		expect((await local.verificar(`${P}-yo`, clave2)).ok).toBe(true);
		expect((await local.verificar(`${P}-yo`, clave1)).ok).toBe(false);
	});
});
