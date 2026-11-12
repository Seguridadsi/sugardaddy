import { describe, expect, it } from 'vitest';
import {
	firmarCatalogoPartner,
	firmarCon,
	firmarDelegacion,
	firmanteDePrivada,
	generarClaves,
	huellaDeFuente,
	motivoTechoPartner,
	verificarCatalogoPartner,
	verificarDelegacion,
	verificarDelegacionCatalogo,
	verificarLicencia,
	verificarPaquetePartner,
	type CatalogoPartner,
	type DelegacionCatalogo,
	type DelegacionCatalogoFirmada
} from './index.ts';

const kino = generarClaves();
const partner = generarClaves();
const atacante = generarClaves();

const AHORA = Date.parse('2026-11-11T10:00:00.000Z');
const HUELLA = 'a'.repeat(64);
const YAML = 'id: acme-portal\nnombre: Portal\n';

const delegacion = (cambios: Partial<DelegacionCatalogo> = {}): DelegacionCatalogo => ({
	tipo: 'delegacion-catalogo',
	version: 1,
	msp: 'acme',
	clavePublica: partner.publica,
	prefijo: 'acme',
	emitida: '2026-11-01T00:00:00.000Z',
	caduca: '2026-12-31T00:00:00.000Z',
	...cambios
});

const certificado = (
	d: object = delegacion(),
	con: string = kino.privada
): DelegacionCatalogoFirmada => {
	const texto = JSON.stringify(d);
	return { delegacion: texto, ...firmarCon(texto, firmanteDePrivada(con), []) };
};

const catalogo = (cambios: Partial<CatalogoPartner> = {}): CatalogoPartner => ({
	tipo: 'catalogo-partner',
	version: 1,
	msp: 'acme',
	serie: 3,
	emitida: '2026-11-10T00:00:00.000Z',
	catalogo: { 'acme-portal': [HUELLA] },
	fuentes: { 'acme-portal': huellaDeFuente(YAML) },
	...cambios
});

const motivo = (f: unknown) => {
	const v = verificarCatalogoPartner(kino.publica, f, AHORA);
	return v.ok ? null : v.motivo;
};

describe('catálogo de trampas de un partner', () => {
	it('con el certificado de SeguridadSI y la firma del partner, se acepta', () => {
		const f = firmarCatalogoPartner(partner.privada, catalogo(), certificado());
		const v = verificarCatalogoPartner(kino.publica, f, AHORA);
		expect(v.ok).toBe(true);
		if (v.ok) {
			expect(v.delegacion.prefijo).toBe('acme');
			expect(v.catalogo.serie).toBe(3);
		}
	});

	it('no vale un certificado que no firma SeguridadSI', () => {
		const f = firmarCatalogoPartner(
			atacante.privada,
			catalogo(),
			certificado(delegacion({ clavePublica: atacante.publica }), atacante.privada)
		);
		expect(motivo(f)).toMatch(/not signed by SeguridadSI/);
	});

	it('no vale un catálogo firmado con una clave que no es la del certificado', () => {
		const f = firmarCatalogoPartner(atacante.privada, catalogo(), certificado());
		expect(motivo(f)).toMatch(/not signed by the partner key/);
	});

	it('no vale tocado después de firmar', () => {
		const f = firmarCatalogoPartner(partner.privada, catalogo(), certificado());
		expect(motivo({ ...f, catalogo: f.catalogo.replace('"serie":3', '"serie":9') })).toMatch(
			/not signed by the partner key/
		);
	});

	it('no vale con el certificado caducado', () => {
		const f = firmarCatalogoPartner(
			partner.privada,
			catalogo(),
			certificado(delegacion({ caduca: '2026-11-10T00:00:00.000Z' }))
		);
		expect(motivo(f)).toMatch(/expired/);
	});

	it('cada trampa lleva el prefijo del certificado, entero', () => {
		for (const id of ['cowrie', 'acmex-portal', 'acme']) {
			const f = firmarCatalogoPartner(
				partner.privada,
				catalogo({ catalogo: { [id]: [HUELLA] }, fuentes: { [id]: HUELLA } }),
				certificado()
			);
			expect(motivo(f)).toMatch(/partner prefix/);
		}
	});

	it('el catálogo y el certificado son del mismo partner', () => {
		const f = firmarCatalogoPartner(partner.privada, catalogo({ msp: 'otro' }), certificado());
		expect(motivo(f)).toMatch(/different partners/);
	});

	it('rechaza series, huellas y prefijos mal formados', () => {
		const con = (c: Partial<CatalogoPartner>) =>
			motivo(firmarCatalogoPartner(partner.privada, catalogo(c), certificado()));
		expect(con({ serie: 0 })).toMatch(/serial/);
		expect(con({ serie: 1.5 })).toMatch(/serial/);
		expect(con({ catalogo: { 'acme-portal': ['x'] } })).toMatch(/fingerprints/);
		expect(con({ catalogo: { 'acme-portal': [] } })).toMatch(/fingerprints/);
		expect(con({ fuentes: {} })).toMatch(/source fingerprints/);
		expect(con({ fuentes: { 'acme-otra': HUELLA } })).toMatch(/unknown decoy/);
		expect(con({ fuentes: { 'acme-portal': 'x' } })).toMatch(/source fingerprint/);
		const f = firmarCatalogoPartner(
			partner.privada,
			catalogo(),
			certificado(delegacion({ prefijo: 'acme-x' }))
		);
		expect(motivo(f)).toMatch(/prefix/);
	});

	it('un certificado de licencias no sirve para firmar trampas, ni al revés', () => {
		const deLicencias = firmarDelegacion(kino.privada, {
			tipo: 'delegacion-licencias',
			version: 1,
			msp: 'acme',
			clavePublica: partner.publica,
			modulos: ['acme-portal'],
			emitida: '2026-11-01T00:00:00.000Z',
			caduca: '2026-12-31T00:00:00.000Z'
		});
		const f = firmarCatalogoPartner(partner.privada, catalogo(), deLicencias);
		expect(motivo(f)).toMatch(/not a partner decoy certificate/);

		const deTrampas = certificado();
		expect(verificarDelegacionCatalogo(kino.publica, deTrampas, AHORA).ok).toBe(true);
		expect(verificarDelegacion(kino.publica, deTrampas, AHORA).ok).toBe(false);
		const licencia = JSON.stringify({ tipo: 'licencia' });
		expect(
			verificarLicencia(kino.publica, { licencia, firma: 'AAAA', delegacion: deTrampas }, AHORA).ok
		).toBe(false);
	});
});

describe('paquete de un partner: catálogo y manifiestos', () => {
	const firmado = () => firmarCatalogoPartner(partner.privada, catalogo(), certificado());
	const motivoPaquete = (p: unknown) => {
		const v = verificarPaquetePartner(kino.publica, p, AHORA);
		return v.ok ? null : v.motivo;
	};

	it('con los manifiestos que firmó el partner, se acepta', () => {
		expect(motivoPaquete({ firmado: firmado(), manifiestos: { 'acme-portal': YAML } })).toBeNull();
	});

	it('quien lo reparte no puede cambiar un manifiesto', () => {
		expect(
			motivoPaquete({ firmado: firmado(), manifiestos: { 'acme-portal': YAML + 'x: 1\n' } })
		).toMatch(/not the one the partner signed/);
	});

	it('ni quitar ni añadir manifiestos', () => {
		expect(motivoPaquete({ firmado: firmado(), manifiestos: {} })).toMatch(/do not match/);
		expect(
			motivoPaquete({
				firmado: firmado(),
				manifiestos: { 'acme-portal': YAML, 'acme-otra': YAML }
			})
		).toMatch(/do not match/);
		expect(motivoPaquete({ firmado: firmado() })).toMatch(/form of a partner package/);
	});
});

describe('techo de una trampa de partner', () => {
	const base = () => ({
		contenedor: {
			imagen: `registro.acme.example/trampa@sha256:${'b'.repeat(64)}`,
			puertos: [{ interno: 8080 }],
			ficheros: [],
			escribibles: ['/var/log/trampa']
		},
		aislamiento: { salida: false, soloLectura: true, cpu: 0.5, memoriaMb: 128 }
	});

	it('la normal cabe', () => {
		expect(motivoTechoPartner(base())).toBeNull();
	});

	/* Los mismos casos que TestTechoDePartner en el sensor. */
	it('rechaza lo que pasa del techo', () => {
		const con = (cambiar: (m: any) => void) => {
			const m = base();
			cambiar(m);
			return motivoTechoPartner(m);
		};
		expect(con((m) => (m.contenedor.imagen = 'registro.acme.example/trampa:latest'))).toMatch(
			/digest/
		);
		expect(con((m) => (m.red = { modo: 'ip-propia' }))).toMatch(/own-IP/);
		expect(con((m) => (m.aislamiento = null))).toMatch(/isolation block/);
		expect(con((m) => (m.aislamiento.salida = true))).toMatch(/internet/);
		expect(con((m) => (m.aislamiento.soloLectura = false))).toMatch(/read-only/);
		expect(con((m) => (m.aislamiento.cpu = 0))).toMatch(/CPU/);
		expect(con((m) => (m.aislamiento.cpu = 4))).toMatch(/CPU limit/);
		expect(con((m) => (m.aislamiento.memoriaMb = 0))).toMatch(/memory/);
		expect(con((m) => (m.aislamiento.memoriaMb = 4096))).toMatch(/memory limit/);
		expect(con((m) => (m.contenedor.escribibles = Array(9).fill('/x')))).toMatch(/writable/);
		expect(con((m) => (m.contenedor = null))).toMatch(/container/);
	});
});
