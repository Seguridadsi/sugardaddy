/*
 * El dominio del cliente en la base de verdad: lo que se propone a una trampa nueva sin
 * repetir nombres, y a qué trampas ya puestas se les aplica. El cambio en sí va por
 * modificarConElector, el mismo camino que modificar una trampa a mano, y aquí se sustituye.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Honeycosa } from '@sugardaddy/contrato';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('$app/environment', () => ({ building: false, dev: true }));

const modificar = vi.hoisted(() => vi.fn());
vi.mock('./alta', () => ({ modificarConElector: modificar }));

const SMB = {
	id: 'zz-identidad-smb',
	parametros: {
		type: 'object',
		properties: {
			nombreEquipo: {
				type: 'string',
				'x-camuflaje': 'equipo:fs',
				pattern: '^[A-Za-z0-9-]{1,15}$',
				default: 'FS01'
			},
			dominio: { type: 'string', title: 'Dominio', 'x-camuflaje': 'netbios', default: 'WORKGROUP' },
			puerto: { type: 'integer', default: 445 }
		}
	}
} as unknown as Honeycosa;
vi.mock('./catalogo', () => ({ honeycosas: () => [SMB] }));

describe.skipIf(!process.env.DATABASE_URL)('identidad', async () => {
	const { db, schema: s } = await import('./db');
	const { eq, like } = await import('drizzle-orm');
	const { aplicarIdentidad, guardarIdentidad, identidad, propuestasDeAlta, trampasDeFabrica } =
		await import('./identidad');
	const CLAVE = 'identidad';
	const PREFIJO = 'zz-identidad-';
	const SENSOR = `${PREFIJO}sensor`;
	const DESTINO = `${PREFIJO}destino`;

	const trampa = (
		id: string,
		parametros: Record<string, unknown>,
		o: Record<string, unknown> = {}
	) =>
		db.insert(s.trampas).values({
			id: `${PREFIJO}${id}`,
			nombre: id,
			modulo: SMB.id,
			tipo: 'contenedor',
			via: 'contenedor',
			donde: 'zz',
			ejecutor: 'contenedor@1',
			sensor: SENSOR,
			parametros,
			...o
		} as typeof s.trampas.$inferInsert);

	const limpiar = async () => {
		await db.delete(s.trampas).where(like(s.trampas.id, `${PREFIJO}%`));
		await db.delete(s.destinos).where(eq(s.destinos.id, DESTINO));
		await db.delete(s.sensores).where(eq(s.sensores.id, SENSOR));
		await db.delete(s.ajustes).where(eq(s.ajustes.clave, CLAVE));
	};
	/* Las de las demás pruebas de la suite no cuentan: se miran solo las de aquí. */
	beforeEach(async () => {
		await limpiar();
		await db.insert(s.sensores).values({ id: SENSOR, nombre: SENSOR, claveHash: 'x' });
		await db
			.insert(s.destinos)
			.values({ id: DESTINO, nombre: DESTINO, tipo: 'maquina', sensor: SENSOR });
		modificar.mockReset();
		modificar.mockResolvedValue('modificada');
	});
	afterAll(limpiar);

	it('sin contestar, se pregunta; al decir «ahora no» ya no', async () => {
		expect(await identidad()).toEqual({ decidido: false, dominio: null });
		await guardarIdentidad('quien', { decidido: true, dominio: null });
		expect(await identidad()).toMatchObject({ decidido: true, dominio: null });
	});

	it('deja rastro en la auditoría', async () => {
		await guardarIdentidad('zz-identidad@prueba', { decidido: true, dominio: 'acme.es' });
		const [a] = await db
			.select()
			.from(s.auditoria)
			.where(eq(s.auditoria.quien, 'zz-identidad@prueba'));
		expect(a.accion).toBe('dominio de la empresa guardado');
		await db.delete(s.auditoria).where(eq(s.auditoria.quien, 'zz-identidad@prueba'));
	});

	it('la semilla se crea una vez y no cambia al corregir el dominio', async () => {
		await guardarIdentidad('quien', { decidido: true, dominio: 'www.acme.es' });
		const { semilla } = await identidad();
		expect(semilla).toMatch(/^[0-9a-f]{32}$/);
		await guardarIdentidad('quien', { decidido: true, dominio: 'acme.es' });
		expect((await identidad()).semilla).toBe(semilla);
	});

	it('lo que el módulo pide al azar se propone haya dominio o no, y cada vez uno distinto', async () => {
		const CENTINELA = {
			id: 'zz-identidad-centinela',
			parametros: {
				type: 'object',
				properties: {
					carpetas: { type: 'string' },
					servicio: {
						type: 'string',
						'x-aleatorio': { bases: ['RevisionDiscos'], sufijo: 6, alfabeto: 'digitos' }
					}
				}
			}
		} as unknown as Honeycosa;
		const una = await propuestasDeAlta(CENTINELA, DESTINO);
		expect(Object.keys(una)).toEqual(['servicio']);
		expect(una.servicio).toMatch(/^RevisionDiscos\d{6}$/);
		const otras = new Set(
			await Promise.all(
				Array.from({ length: 8 }, async () => (await propuestasDeAlta(CENTINELA, DESTINO)).servicio)
			)
		);
		expect(otras.size).toBeGreaterThan(1);
	});

	it('sin dominio no se propone nada, ni hay nada que aplicar', async () => {
		await trampa('a', { nombreEquipo: 'FS01' });
		expect(await propuestasDeAlta(SMB, DESTINO)).toEqual({});
		expect(await trampasDeFabrica()).toEqual([]);
		expect(await aplicarIdentidad('quien')).toEqual({ cambiadas: [], sinCambiar: [] });
		expect(modificar).not.toHaveBeenCalled();
	});

	it('la propuesta no repite un nombre que ya usa otra trampa', async () => {
		await guardarIdentidad('quien', { decidido: true, dominio: 'acme.es' });
		const primera = await propuestasDeAlta(SMB, DESTINO);
		expect(primera.dominio).toBe('ACME');
		await trampa('a', { nombreEquipo: primera.nombreEquipo });
		const segunda = await propuestasDeAlta(SMB, DESTINO);
		expect(segunda.nombreEquipo).not.toBe(primera.nombreEquipo);
	});

	it('aplica solo a las de contenedor activas con algún nombre de fábrica', async () => {
		await trampa('fabrica', { nombreEquipo: 'FS01', dominio: 'WORKGROUP', puerto: 445 });
		await trampa('mitad', { nombreEquipo: 'mi-servidor', dominio: 'WORKGROUP' });
		await trampa('suya', { nombreEquipo: 'mi-servidor', dominio: 'MIDOMINIO' });
		await trampa('parada', { nombreEquipo: 'FS01' }, { activo: false });
		await trampa('a-mano', { nombreEquipo: 'FS01' }, { ejecutor: 'manual@1' });
		await guardarIdentidad('quien', { decidido: true, dominio: 'acme.es' });

		const lista = await trampasDeFabrica();
		expect(lista.map((t) => t.nombre).sort()).toEqual(['fabrica', 'mitad']);
		expect(lista.find((t) => t.nombre === 'mitad')!.cambios).toEqual([
			{ campo: 'Dominio', antes: 'WORKGROUP', despues: 'ACME' }
		]);
		const r = await aplicarIdentidad('quien');
		expect(r.cambiadas.sort()).toEqual(['fabrica', 'mitad']);
		expect(modificar).toHaveBeenCalledTimes(2);

		const llamada = (nombre: string) =>
			modificar.mock.calls.find((c) => c[3].nombre === nombre)![3].parametros;
		const fabrica = llamada('fabrica');
		expect(fabrica.dominio).toBe('ACME');
		expect(fabrica.puerto).toBe(445);
		expect(fabrica.nombreEquipo).toContain('FS');
		/* Lo que había escrito el cliente se queda. */
		const mitad = llamada('mitad');
		expect(mitad.nombreEquipo).toBe('mi-servidor');
		expect(mitad.dominio).toBe('ACME');
	});

	it('una trampa de cara a internet no toma el dominio, ni la del sensor ni la suya', async () => {
		await trampa('externa', { nombreEquipo: 'FS01' }, { entorno: 'perimetro-web' });
		await db.update(s.sensores).set({ entorno: 'perimetro-web' }).where(eq(s.sensores.id, SENSOR));
		await trampa('del-sensor', { nombreEquipo: 'FS01' });
		await trampa('interna', { nombreEquipo: 'FS01' }, { entorno: 'dentro' });
		await guardarIdentidad('quien', { decidido: true, dominio: 'acme.es' });
		expect((await trampasDeFabrica()).map((t) => t.nombre)).toEqual(['interna']);
		expect(await propuestasDeAlta(SMB, DESTINO)).toEqual({});
	});

	it('repetir no cambia nada; corregir el dominio cambia lo que puso el nodo', async () => {
		modificar.mockImplementation(async (_q, t, _h, v) => {
			await db.update(s.trampas).set({ parametros: v.parametros }).where(eq(s.trampas.id, t.id));
			return 'modificada';
		});
		await trampa('a', { nombreEquipo: 'FS01', dominio: 'WORKGROUP' });
		await trampa('suya', { nombreEquipo: 'mi-servidor', dominio: 'MIO' });
		await guardarIdentidad('quien', { decidido: true, dominio: 'www-mal.es' });
		await aplicarIdentidad('quien');
		expect(await trampasDeFabrica()).toEqual([]);
		expect((await aplicarIdentidad('quien')).cambiadas).toEqual([]);

		await guardarIdentidad('quien', { decidido: true, dominio: 'acme.es' });
		expect((await trampasDeFabrica()).map((t) => t.nombre)).toEqual(['a']);
		await aplicarIdentidad('quien');
		const [a] = await db
			.select()
			.from(s.trampas)
			.where(eq(s.trampas.id, `${PREFIJO}a`));
		expect(a.parametros.dominio).toBe('ACME');
		const [suya] = await db
			.select()
			.from(s.trampas)
			.where(eq(s.trampas.id, `${PREFIJO}suya`));
		expect(suya.parametros.nombreEquipo).toBe('mi-servidor');
		expect(await trampasDeFabrica()).toEqual([]);
	});

	it('dos trampas de fábrica no acaban con el mismo nombre', async () => {
		await trampa('una', { nombreEquipo: 'FS01' });
		await trampa('otra', { nombreEquipo: 'FS01' });
		await guardarIdentidad('quien', { decidido: true, dominio: 'acme.es' });
		await aplicarIdentidad('quien');
		const nombres = modificar.mock.calls.map((c) => c[3].parametros.nombreEquipo);
		expect(new Set(nombres).size).toBe(2);
	});

	it('la que no se deja cambiar se queda, y se dice', async () => {
		await trampa('apuntada', { nombreEquipo: 'FS01' });
		modificar.mockResolvedValue({ motivos: [], errores: ['otras apuntan a ella'] });
		await guardarIdentidad('quien', { decidido: true, dominio: 'acme.es' });
		expect(await aplicarIdentidad('quien')).toEqual({
			cambiadas: [],
			sinCambiar: [{ nombre: 'apuntada', motivo: 'otras apuntan a ella' }]
		});
	});
});
