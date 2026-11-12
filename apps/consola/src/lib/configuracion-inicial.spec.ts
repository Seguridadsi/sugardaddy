import { describe, expect, it } from 'vitest';
import { SIN_EMPEZAR, pasos, pendientes, type Hechos } from './configuracion-inicial';

const RECIEN: Hechos = {
	community: false,
	cuentaLocal: false,
	acceso: 'pendiente',
	hayCodigo: true,
	dominioDecidido: false,
	dominio: null,
	puedeRegistrarse: false,
	registrado: false,
	registroDecidido: false,
	hayAvisos: false,
	raizPropia: true,
	hayTrampa: false,
	trampaProbada: false
};

const estados = (h: Hechos, g = SIN_EMPEZAR) =>
	Object.fromEntries(pasos(h, g).map((p) => [p.id, p.estado]));

describe('configuración inicial', () => {
	it('recién instalada en Cloud: todo pendiente menos la cuenta, y con avisos en vez de registro', () => {
		expect(estados(RECIEN)).toEqual({
			cuenta: 'hecho',
			acceso: 'pendiente',
			codigo: 'pendiente',
			empresa: 'pendiente',
			avisos: 'pendiente',
			certificado: 'pendiente',
			trampa: 'pendiente'
		});
	});

	it('en Community sale el registro y no los avisos; con panel, ninguno de los dos', () => {
		const ids = (h: Hechos) => pasos(h, SIN_EMPEZAR).map((p) => p.id);
		expect(ids({ ...RECIEN, community: true, puedeRegistrarse: true })).toContain('registro');
		expect(ids({ ...RECIEN, community: true, puedeRegistrarse: true })).not.toContain('avisos');
		const gestionada = ids({ ...RECIEN, community: true, puedeRegistrarse: false });
		expect(gestionada).not.toContain('registro');
		expect(gestionada).not.toContain('avisos');
	});

	it('con certificado del cliente no hay raíz que instalar', () => {
		expect(estados({ ...RECIEN, raizPropia: false })).not.toHaveProperty('certificado');
	});

	it('lo que sale del nodo se da por hecho sin confirmar nada', () => {
		const e = estados({
			...RECIEN,
			acceso: 'restringida',
			dominioDecidido: true,
			dominio: 'empresa.es',
			hayAvisos: true,
			hayTrampa: true,
			trampaProbada: true
		});
		expect(e).toMatchObject({
			acceso: 'hecho',
			empresa: 'hecho',
			avisos: 'hecho',
			trampa: 'hecho'
		});
		/* El código y la raíz solo los sabe la persona. */
		expect(e).toMatchObject({ codigo: 'pendiente', certificado: 'pendiente' });
	});

	it('una trampa puesta pero sin probar sigue pendiente', () => {
		expect(estados({ ...RECIEN, hayTrampa: true }).trampa).toBe('pendiente');
	});

	it('dejar abierta la consola es haber decidido el acceso', () => {
		expect(estados({ ...RECIEN, acceso: 'abierta' }).acceso).toBe('hecho');
	});

	it('el «ahora no» del dominio y de la oferta de registro cuentan como omitidos', () => {
		expect(estados({ ...RECIEN, dominioDecidido: true }).empresa).toBe('omitido');
		expect(
			estados({ ...RECIEN, community: true, puedeRegistrarse: true, registroDecidido: true })
				.registro
		).toBe('omitido');
	});

	it('el código confirmado deja de valer si el nodo ya no tiene código', () => {
		const g = { ...SIN_EMPEZAR, confirmados: { codigo: 'hecho' as const } };
		expect(estados(RECIEN, g).codigo).toBe('hecho');
		expect(estados({ ...RECIEN, hayCodigo: false }, g).codigo).toBe('pendiente');
	});

	it('el código no se puede dejar para más adelante; lo demás opcional, sí', () => {
		const lista = pasos(RECIEN, SIN_EMPEZAR);
		const de = (id: string) => lista.find((p) => p.id === id)!;
		expect(de('codigo')).toMatchObject({ omitible: false, manual: true });
		expect(de('acceso')).toMatchObject({ omitible: false, manual: false });
		expect(de('certificado')).toMatchObject({ omitible: true, manual: true });
		expect(de('trampa')).toMatchObject({ omitible: true, manual: false });
	});

	it('sin pendientes cuando cada paso está hecho u omitido', () => {
		const g = {
			...SIN_EMPEZAR,
			confirmados: {
				codigo: 'hecho' as const,
				empresa: 'omitido' as const,
				avisos: 'omitido' as const,
				certificado: 'omitido' as const,
				trampa: 'omitido' as const
			}
		};
		expect(pendientes(pasos({ ...RECIEN, acceso: 'restringida' }, g))).toEqual([]);
		expect(pendientes(pasos(RECIEN, g)).map((p) => p.id)).toEqual(['acceso']);
	});
});
