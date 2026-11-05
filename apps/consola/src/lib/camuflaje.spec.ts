/*
 * Los nombres que salen del dominio: creíbles, distintos entre clientes, siempre los
 * mismos para cada uno, y aceptados por lo que admite cada parámetro de cada trampa.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { validarParametros, type EsquemaParametros } from '@sugardaddy/contrato';
import {
	TIPO_CAMUFLAJE,
	cambiosDeFabrica,
	leerDominio,
	prefijoDe,
	proponer,
	propuestas,
	sugerirDominio
} from './camuflaje';

describe('leerDominio', () => {
	it('limpia lo que la gente escribe', () => {
		for (const t of [
			'acme.es',
			' ACME.ES ',
			'https://acme.es/',
			'https://www.acme.es/contacto',
			'www.acme.es',
			'correo@acme.es',
			'acme.es.',
			'acme.es:443'
		])
			expect(leerDominio(t), t).toBe('acme.es');
		expect(leerDominio('corp.acme.local')).toBe('corp.acme.local');
	});
	it('un dominio con eñes o acentos se guarda como en el DNS', () => {
		expect(leerDominio('piñones.es')).toBe('xn--piones-xwa.es');
		expect(leerDominio('xn--piones-xwa.es')).toBe('xn--piones-xwa.es');
	});
	it('rechaza lo que no es un dominio', () => {
		for (const t of [
			'',
			'acme',
			'10.0.0.5',
			'acme..es',
			'-acme.es',
			'acme .es',
			'a'.repeat(300) + '.es'
		])
			expect(leerDominio(t), t).toBeNull();
	});
});

describe('sugerirDominio', () => {
	it('quita el nombre del equipo de la dirección con que se entra', () => {
		expect(sugerirDominio('gestion.aldanza.local')).toBe('aldanza.local');
		expect(sugerirDominio('acme.es')).toBe('acme.es');
	});
	it('no se queda con un sufijo público', () => {
		expect(sugerirDominio('acme.co.uk')).toBe('acme.co.uk');
		expect(sugerirDominio('gestion.acme.co.uk')).toBe('acme.co.uk');
	});
	it('no sugiere nada que no sería de la empresa', () => {
		for (const h of [
			'168.62.164.208',
			'localhost',
			'[::1]',
			'',
			'sugardaddy.local',
			'consola.sugardaddy.seguridadsi.com',
			'x.westeurope.cloudapp.azure.com',
			'nodo.fritz.box'
		])
			expect(sugerirDominio(h), h).toBe('');
	});
});

describe('prefijoDe', () => {
	it('toma la etiqueta que dice de quién es', () => {
		expect(prefijoDe('acme.es')).toBe('acme');
		expect(prefijoDe('corp.acme.es')).toBe('acme');
		expect(prefijoDe('ad.corp.acme.local')).toBe('acme');
		expect(prefijoDe('grupo-sur.es')).toBe('gruposur');
		expect(prefijoDe('corp.local')).toBe('corp');
		expect(prefijoDe('acme.co.uk')).toBe('acme');
		expect(prefijoDe('acme.com.es')).toBe('acme');
		expect(prefijoDe('es.acme.com')).toBe('acme');
	});
	it('sin acentos, y nunca solo cifras', () => {
		expect(prefijoDe('xn--piones-xwa.es')).toBe('pinones');
		expect(prefijoDe('123.es')).toBe('srv123');
	});
});

/* Muchos dominios y semillas, para pasar por todas las formas de nombrar. */
const DOMINIOS = [
	'acme.es',
	'grupoempresarialdelsur.es',
	'a.io',
	'corp.local',
	'123.es',
	'piñones.es'
];
const SEMILLAS = Array.from({ length: 40 }, (_, i) => `semilla-${i}`);

describe('proponer', () => {
	it('dominio, netbios y buzón', () => {
		expect(proponer('dominio', 'corp.acme.es')).toBe('corp.acme.es');
		expect(proponer('netbios', 'corp.acme.es')).toBe('ACME');
		expect(proponer('correo:soporte', 'acme.es')).toBe('soporte@acme.es');
	});
	it('parecido nunca es el dominio real', () => {
		expect(proponer('parecido', 'acme.es')).toBe('acme-ad.local');
		expect(proponer('parecido', 'corp.acme.es')).toBe('acme-ad.local');
		expect(proponer('parecido', 'acme-ad.local')).not.toBe('acme-ad.local');
	});
	it('un equipo de Windows nunca pasa de 15 caracteres, y va en mayúsculas', () => {
		for (const d of DOMINIOS.map((x) => leerDominio(x)!))
			for (const semilla of SEMILLAS) {
				const v = proponer('equipo:sql', d, { semilla })!;
				expect(v.length, v).toBeLessThanOrEqual(15);
				expect(v).toMatch(/^[A-Z0-9-]+$/);
				expect(v).toContain('SQL');
				expect(v).not.toMatch(/^\d+$/);
			}
	});
	it('un equipo de Linux va en minúsculas', () => {
		for (const semilla of SEMILLAS)
			expect(proponer('host:bak', 'acme.es', { semilla })).toMatch(/^[a-z0-9-]*bak/);
	});
	it('un switch no se llama srv-', () => {
		for (const semilla of SEMILLAS)
			expect(proponer('host:sw', 'acme.es', { semilla })).not.toMatch(/^srv-/);
	});
	it('siempre lo mismo para un dominio y una semilla', () => {
		const o = { semilla: 'x' };
		expect(proponer('equipo:fs', 'acme.es', o)).toBe(proponer('equipo:fs', 'acme.es', o));
	});
	it('sabiendo solo el dominio no se puede calcular: la semilla lo cambia', () => {
		const nombres = new Set(
			SEMILLAS.map((semilla) => proponer('equipo:fs', 'acme.es', { semilla }))
		);
		expect(nombres.size).toBeGreaterThan(10);
	});
	it('los números no delatan: hay de todos, también el 01', () => {
		const numeros = new Set(
			SEMILLAS.flatMap((semilla) =>
				/(\d\d)/.exec(proponer('fqdn:mail', 'acme.es', { semilla })!)?.slice(1)
			)
		);
		expect(numeros.size).toBeGreaterThan(5);
		const todos = Array.from({ length: 400 }, (_, i) =>
			proponer('fqdn:mail', 'acme.es', { semilla: `s${i}` })
		);
		expect(todos).toContain('mail01.acme.es');
	});
	it('no repite un nombre que ya usa otra trampa', () => {
		const a = proponer('equipo:fs', 'acme.es', { semilla: 'x' })!;
		const b = proponer('equipo:fs', 'acme.es', {
			semilla: 'x',
			usados: new Set([a.toLowerCase()])
		})!;
		expect(b).not.toBe(a);
	});
	it('un tipo que no conoce no da nada', () => {
		expect(proponer('otra:cosa', 'acme.es')).toBeNull();
		expect(proponer('equipo:RARO', 'acme.es')).toBeNull();
	});
});

describe('propuestas', () => {
	const esquema = {
		properties: {
			nombre: {
				type: 'string',
				'x-camuflaje': 'equipo:fs',
				pattern: '^[A-Za-z0-9-]{1,15}$',
				default: 'FS01'
			},
			dos: { type: 'string', 'x-camuflaje': 'equipo:fs', default: 'FS02' },
			estrecho: { type: 'string', 'x-camuflaje': 'dominio', maxLength: 3 },
			puerto: { type: 'integer', default: 445 }
		}
	};
	it('solo lo que el módulo declara y le cabe, sin repetir nombres entre sí', () => {
		const p = propuestas(esquema, 'acme.es');
		expect(Object.keys(p)).toEqual(['nombre', 'dos']);
		expect(p.nombre).not.toBe(p.dos);
	});
	it('recorta el prefijo si el parámetro no admite el nombre entero', () => {
		const corto = {
			properties: { n: { type: 'string', 'x-camuflaje': 'host:mqtt', maxLength: 16 } }
		};
		for (const semilla of SEMILLAS) {
			const p = propuestas(corto, 'supermercadosdelsurdeandalucia.es', { semilla });
			expect(p.n.length, p.n).toBeLessThanOrEqual(16);
		}
	});
});

describe('cambiosDeFabrica', () => {
	const esquema = {
		properties: {
			nombre: { type: 'string', default: 'FS01' },
			dos: { type: 'string', default: 'FS02' }
		}
	};
	const p = { nombre: 'ACME-FS02', dos: 'ACME-FS03' };
	it('solo donde sigue lo de fábrica o nada', () => {
		expect(cambiosDeFabrica(esquema, { nombre: 'FS01', dos: 'el-mio' }, p)).toEqual({
			nombre: 'ACME-FS02'
		});
		expect(cambiosDeFabrica(esquema, {}, p)).toEqual(p);
		expect(cambiosDeFabrica(esquema, { nombre: 'mio', dos: 'mio' }, p)).toEqual({});
	});
	it('lo que puso el nodo se puede cambiar: así se corrige un dominio mal escrito', () => {
		expect(
			cambiosDeFabrica(esquema, { nombre: 'WWW-FS02', dos: 'mio' }, p, { nombre: 'WWW-FS02' })
		).toEqual({
			nombre: 'ACME-FS02'
		});
	});
	it('si ya tiene ese valor no hay nada que hacer, aunque coincida con el de fábrica', () => {
		expect(cambiosDeFabrica(esquema, { nombre: 'ACME-FS02', dos: 'ACME-FS03' }, p)).toEqual({});
		expect(cambiosDeFabrica(esquema, { nombre: 'X', dos: 'FS02' }, { dos: 'FS02' })).toEqual({});
	});
	it('el dominio de Windows y el DNS van juntos', () => {
		const rdp = {
			properties: {
				dominio: { type: 'string', 'x-camuflaje': 'netbios', default: 'WORKGROUP' },
				dominioDns: { type: 'string', 'x-camuflaje': 'dominio', default: '' }
			}
		};
		const q = { dominio: 'ACME', dominioDns: 'acme.es' };
		expect(cambiosDeFabrica(rdp, { dominio: 'WORKGROUP', dominioDns: '' }, q)).toEqual(q);
		expect(cambiosDeFabrica(rdp, { dominio: 'OFICINA', dominioDns: '' }, q)).toEqual({});
		expect(cambiosDeFabrica(rdp, { dominio: 'WORKGROUP', dominioDns: 'corp.otra.com' }, q)).toEqual(
			{}
		);
	});
});

describe('en los manifiestos de verdad', () => {
	const raiz = join(__dirname, '..', '..', '..', '..', 'modulos', 'trampas');
	const modulos = readdirSync(raiz)
		.map((d) => join(raiz, d, 'trampa.yaml'))
		.filter(existsSync)
		.map((f) => parse(readFileSync(f, 'utf8')) as { id: string; parametros?: EsquemaParametros });
	const conCamuflaje = modulos.filter((m) =>
		Object.values(m.parametros?.properties ?? {}).some(
			(p) => (p as { 'x-camuflaje'?: string })['x-camuflaje']
		)
	);

	it('los hay', () => {
		expect(conCamuflaje.length).toBeGreaterThan(0);
	});

	it('todos los tipos se entienden', () => {
		for (const m of conCamuflaje)
			for (const [k, p] of Object.entries(m.parametros!.properties)) {
				const t = (p as { 'x-camuflaje'?: string })['x-camuflaje'];
				if (t) expect(t, `${m.id}.${k}`).toMatch(TIPO_CAMUFLAJE);
			}
	});

	/* Es de pago: en community no está. */
	const dc = modulos.find((m) => m.id === 'controlador-dominio');
	it.skipIf(!dc)('el controlador de dominio nunca toma el dominio real', () => {
		expect(propuestas(dc!.parametros!, 'acme.es').dominio).not.toContain('acme.es');
	});

	it.each([
		'acme.es',
		'corp.grupoaldanza-sur.local',
		'a.io',
		'empresa-con-un-nombre-muy-largo-de-verdad.com',
		'supermercadosdelsurdeandalucia.es'
	])('lo propuesto con %s lo acepta cada trampa, y no se queda ninguno sin proponer', (dominio) => {
		for (const m of conCamuflaje) {
			const esquema = m.parametros!;
			const declarados = Object.entries(esquema.properties).filter(
				([, d]) => (d as { 'x-camuflaje'?: string })['x-camuflaje']
			);
			const base = Object.fromEntries(
				(esquema.required ?? []).flatMap((k) => {
					const def = esquema.properties[k] as { default?: unknown };
					return def.default === undefined ? [] : [[k, def.default]];
				})
			);
			for (const semilla of SEMILLAS) {
				const p = propuestas(esquema, dominio, { semilla });
				expect(Object.keys(p).sort(), m.id).toEqual(declarados.map(([k]) => k).sort());
				const r = validarParametros(esquema, { ...base, ...p });
				const errores = r.ok
					? []
					: r.errores.filter((e) => declarados.some(([k]) => e.includes(k)));
				expect(errores, `${m.id}: ${JSON.stringify(p)}`).toEqual([]);
			}
		}
	});
});
