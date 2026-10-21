import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
	leerHoneycosa,
	leerTrampa,
	proyectarParaSensor,
	tipoEvento,
	traductorDe,
	validarCatalogo,
	validarHoneycosa,
	validarTrampa,
	variablesDeVia,
	viasEstables,
	type Honeycosa
} from './index.ts';

/*
 * Manifiesto v2 (docs/diseno/modulo-despliegue.md §2, paso 1b): el esquema,
 * las reglas 1 a 9 de validarHoneycosa, validarCatalogo y la regla 10.
 */

const raiz = join(import.meta.dirname, '../../..');
const leer = (...ruta: string[]) => readFileSync(join(raiz, ...ruta), 'utf8');
const trampas = readdirSync(join(raiz, 'modulos/trampas'));
const ejemplo = (nombre: string) => leer('paquetes/contrato/src/ejemplos', nombre);

/* Los ejemplos como objeto, para estropearlos en cada prueba. */
type Datos = any;
const smb = (): Datos => parse(ejemplo('smb.v2.yaml'));
const credencial = (): Datos => parse(ejemplo('credencial-ssh.v2.yaml'));

function honeycosa(dato: unknown): Honeycosa {
	const r = validarHoneycosa(dato);
	if (!r.ok) throw new Error(r.errores.join('\n'));
	return r.valor;
}

function errores(dato: unknown): string[] {
	const r = validarHoneycosa(dato);
	return r.ok ? [] : r.errores;
}

/* Cada trampa de modulos/trampas, como honeycosa (v1 normalizado). */
const catalogo = () =>
	trampas.map((m) => {
		const r = leerHoneycosa(leer('modulos/trampas', m, 'trampa.yaml'));
		if (!r.ok) throw new Error(r.errores.join('\n'));
		return r.valor;
	});

/* Una honeycosa de origen 1 escrita como YAML v2 (JSON es YAML). */
const comoV2 = (h: Honeycosa): Datos => {
	const { origen, ...v2 } = h;
	expect(origen).toBe(1);
	return JSON.parse(JSON.stringify(v2));
};

describe('manifiesto v2: los ejemplos', () => {
	it('smb.v2 se lee como honeycosa de origen 2, con sus dos vías', () => {
		const r = leerHoneycosa(ejemplo('smb.v2.yaml'));
		if (!r.ok) throw new Error(r.errores.join('\n'));
		expect(r.valor).toMatchObject({ version: 2, origen: 2, siembra: { clase: 'servicio' } });
		expect(r.valor.vias.map((v) => [v.id, v.ejecutor])).toEqual([
			['contenedor', 'contenedor@1'],
			['carpeta-auditada', 'manual@1']
		]);
		/* Sin requisitos en el YAML: la forma normalizada lleva []. */
		expect(r.valor.vias[0].requisitos).toEqual([]);
		expect(r.valor.vias[1].requisitos).toHaveLength(2);
		expect(tipoEvento(r.valor)).toBe('contenedor');
	});

	it('la proyección de smb.v2 pasa validarTrampa, con ficha.instalacion rellena', () => {
		const h = honeycosa(smb());
		const p = proyectarParaSensor(h, 'contenedor');
		expect(validarTrampa(p)).toMatchObject({ ok: true });
		expect(p.ficha?.instalacion).toEqual({
			automatica: true,
			manual: [
				expect.stringContaining('Comprueba que la auditoría'),
				'Crea la carpeta ${ruta} y compártela como «${recurso}», solo lectura para todos. Si ya hay un recurso con ese nombre o ya existe la carpeta, para sin tocar nada.'
			]
		});
		expect(p).toMatchObject({ version: 1, id: 'smb', tipo: 'contenedor' });
		expect(p.eventos).toEqual({
			fuente: { tipo: 'fichero', ruta: 'smb.json' },
			...h.senal.eventos
		});
		expect(p).not.toHaveProperty('sensorMinimo');
	});

	it('la vía contenedor de smb.v2 es la trampa smb de modulos/trampas', () => {
		const v1 = leerTrampa(leer('modulos/trampas/smb/trampa.yaml'));
		if (!v1.ok) throw new Error(v1.errores.join('\n'));
		const p = proyectarParaSensor(honeycosa(smb()), 'contenedor');
		/* Lo que el sensor usa para desplegarla y traducir sus eventos, igual. */
		for (const campo of ['tipo', 'contenedor', 'aislamiento', 'eventos', 'procedencia'] as const)
			expect(p[campo]).toEqual(v1.valor[campo]);
		/* Sus parámetros, y además los dos de la vía de Windows. */
		expect(p.parametros.properties).toEqual({
			...v1.valor.parametros.properties,
			recurso: expect.any(Object),
			ruta: expect.any(Object)
		});
	});

	it('la ficha de un v2 se proyecta con lo que trae, y sin vía manual queda solo automática', () => {
		const conInstalacion = smb();
		conInstalacion.ficha.instalacion = { automatica: true, manual: ['Lo que diga el autor.'] };
		expect(proyectarParaSensor(honeycosa(conInstalacion), 'contenedor').ficha?.instalacion).toEqual(
			{ automatica: true, manual: ['Lo que diga el autor.'] }
		);
		const soloContenedor = smb();
		soloContenedor.vias = soloContenedor.vias.slice(0, 1);
		expect(proyectarParaSensor(honeycosa(soloContenedor), 'contenedor').ficha?.instalacion).toEqual(
			{ automatica: true }
		);
		const sinFicha = smb();
		delete sinFicha.ficha;
		expect(proyectarParaSensor(honeycosa(sinFicha), 'contenedor')).not.toHaveProperty('ficha');
	});

	it('los pasos largos se recortan para la ficha de v1 (20 de 500 caracteres)', () => {
		const m = smb();
		m.vias[1].carga.pasos = Array.from({ length: 25 }, (_, i) => ({
			texto: `${i} ${'ñ'.repeat(600)}`
		}));
		const manual = proyectarParaSensor(honeycosa(m), 'contenedor').ficha?.instalacion.manual;
		expect(manual).toHaveLength(20);
		expect(manual?.every((t) => Array.from(t).length === 500)).toBe(true);
		expect(validarTrampa(proyectarParaSensor(honeycosa(m), 'contenedor')).ok).toBe(true);
	});

	it('credencial-ssh.v2 se lee, y no se puede mandar a un sensor', () => {
		const r = leerHoneycosa(ejemplo('credencial-ssh.v2.yaml'));
		if (!r.ok) throw new Error(r.errores.join('\n'));
		expect(r.valor.vias.map((v) => v.id)).toEqual(['windows', 'linux']);
		expect(tipoEvento(r.valor)).toBe('identidad');
		expect(() => proyectarParaSensor(r.valor, 'windows')).toThrow('contenedor@1');
	});

	it('cada vía usa su traductor o el de la raíz; la de otra trampa, ninguno', () => {
		const h = honeycosa(smb());
		expect(traductorDe(h, 'contenedor')).toBe(h.senal.eventos);
		expect(traductorDe(h, 'carpeta-auditada')).toMatchObject({ accion: { campo: 'EventID' } });
		expect(traductorDe(honeycosa(credencial()), 'windows')).toBeUndefined();
	});
});

/* Las que siguen en v1: una que ya está en v2 no tiene un leerTrampa con que compararla. */
const deV1 = trampas.filter((m) => parse(leer('modulos/trampas', m, 'trampa.yaml'))?.version !== 2);

describe('manifiesto v2: cada trampa de hoy escrita en v2', () => {
	it.each(deV1)('%s en v2 es válida y el sensor recibe lo mismo', (m) => {
		const v1 = leerTrampa(leer('modulos/trampas', m, 'trampa.yaml'));
		if (!v1.ok) throw new Error(v1.errores.join('\n'));
		const h = honeycosa(comoV2(catalogo().find((c) => c.id === m)!));
		expect(h.origen).toBe(2);
		expect(proyectarParaSensor(h, 'contenedor')).toEqual(v1.valor);
	});
});

describe('manifiesto v2: lo que se rechaza', () => {
	it('una vía sin señal', () => {
		const m = smb();
		delete m.vias[1].senal;
		expect(errores(m)).toEqual([
			'vias[1] (carpeta-auditada): una vía necesita señal (senal.fuente)'
		]);
		const sinFuente = smb();
		sinFuente.vias[0].senal = {};
		expect(errores(sinFuente)).toContain(
			'vias[0] (contenedor): una vía necesita señal (senal.fuente)'
		);
	});

	it('ids de vía repetidos, también contando los «antes»', () => {
		const m = smb();
		m.vias[1].id = 'contenedor';
		expect(errores(m)).toContain('vias: el id contenedor se repite');
		const antes = smb();
		antes.vias[1].antes = ['contenedor'];
		expect(errores(antes)).toEqual([
			'vias (carpeta-auditada): antes: contenedor ya señala la vía contenedor'
		]);
	});

	it('manual@1 sin retirada manual', () => {
		const m = smb();
		m.vias[1].retirada = { tipo: 'automatica' };
		expect(errores(m)).toEqual([
			'vias[1] (carpeta-auditada): manual@1 exige retirada manual con sus pasos (retirar no deja restos)'
		]);
		const sinPasos = smb();
		sinPasos.vias[1].retirada = { tipo: 'manual', pasos: [] };
		expect(errores(sinPasos)).not.toEqual([]);
		const sinNada = smb();
		sinNada.vias[1].retirada = { tipo: 'manual' };
		expect(errores(sinNada)).not.toEqual([]);
	});

	it('manual@1 con la fuente fichero', () => {
		const m = smb();
		m.vias[1].senal.fuente = { tipo: 'fichero', ruta: 'smb.json' };
		expect(errores(m)).toEqual([
			'vias[1] (carpeta-auditada): manual@1 no admite la fuente fichero (nadie lee un fichero en un destino sin agente)'
		]);
	});

	it('un ${x} que no es un parámetro ni una variable de contexto, en un texto o en una marca', () => {
		const m = smb();
		m.vias[1].carga.pasos[1].texto = 'Crea ${inventado} en ${destino.nombre}.';
		expect(errores(m)).toEqual([
			'vias[1] (carpeta-auditada): carga.pasos[1].texto: ${inventado} no es un parámetro declarado ni una variable de contexto'
		]);
		const marca = credencial();
		marca.vias[0].senal.fuente.marca.igual = '${usuario}-${otro}';
		expect(errores(marca)).toEqual([
			'vias[0] (windows): senal.fuente.marca: ${otro} no es un parámetro declarado ni una variable de contexto'
		]);
		const retirada = smb();
		retirada.vias[1].retirada.pasos[0].texto = 'Borra ${trampa.id} y ${destino.ip}.';
		expect(errores(retirada)).toEqual([
			'vias[1] (carpeta-auditada): retirada.pasos[0].texto: ${destino.ip} no es un parámetro declarado ni una variable de contexto'
		]);
	});

	it('${nonce} solo en la prueba', () => {
		const m = smb();
		m.vias[1].carga.pasos[1].texto = 'Crea sdprueba${nonce}.';
		expect(errores(m)).toEqual([
			'vias[1] (carpeta-auditada): carga.pasos[1].texto: ${nonce} solo vale en comprobacion.prueba'
		]);
		const orden = credencial();
		orden.vias[1].carga.pasos[0].orden = 'echo "$SD_NONCE"';
		expect(errores(orden)).toEqual([
			'vias[1] (linux): carga.pasos[0].orden: SD_NONCE solo vale en comprobacion.prueba'
		]);
	});

	it('${…} dentro de una orden o de un comprobar', () => {
		const m = smb();
		m.vias[1].carga.pasos[1].orden = 'New-Item -Path ${ruta}';
		m.vias[1].carga.pasos[0].comprobar = 'Test-Path ${env:TEMP}';
		expect(errores(m)).toEqual([
			'vias[1] (carpeta-auditada): carga.pasos[0].comprobar: es código y no admite ${…}; usa el bloque de variables ($sd.<clave> o SD_<CLAVE>)',
			'vias[1] (carpeta-auditada): carga.pasos[1].orden: es código y no admite ${…}; usa el bloque de variables ($sd.<clave> o SD_<CLAVE>)'
		]);
		const sh = credencial();
		sh.vias[1].retirada.pasos[0].orden = 'rm -f "${SD_SESION}"';
		expect(errores(sh)).toEqual([
			'vias[1] (linux): retirada.pasos[0].orden: es código y no admite ${…}; usa el bloque de variables ($sd.<clave> o SD_<CLAVE>)'
		]);
	});

	it('$sd.x o SD_X sin declarar, y $sd usado de otra forma', () => {
		const m = smb();
		m.vias[1].retirada.pasos[0].orden = 'Remove-Item -LiteralPath $sd.carpeta';
		expect(errores(m)).toEqual([
			'vias[1] (carpeta-auditada): retirada.pasos[0].orden: $sd.carpeta no es un parámetro declarado ni una variable de contexto'
		]);
		const sh = credencial();
		sh.vias[1].carga.pasos[0].orden = 'echo "$SD_CONEXION" "$SD_DESTINO_DIRECCION"';
		expect(errores(sh)).toEqual([
			'vias[1] (linux): carga.pasos[0].orden: SD_CONEXION no es un parámetro declarado ni una variable de contexto'
		]);
		const suelto = smb();
		suelto.vias[1].retirada.pasos[0].orden = "Remove-Item -LiteralPath $sd['ruta']";
		expect(errores(suelto)).toEqual([
			'vias[1] (carpeta-auditada): retirada.pasos[0].orden: $sd solo se usa como $sd.<clave>'
		]);
	});

	it('un parámetro en una orden tiene que ser numérico o tener sus valores cerrados', () => {
		const m = smb();
		delete m.parametros.properties.recurso.pattern;
		expect(errores(m)).toContain(
			'vias[1] (carpeta-auditada): carga.pasos[1].orden: $sd.recurso: el parámetro recurso va en una orden y no es numérico ni declara un enum o un pattern anclado (^…$)'
		);
		const sinAncla = smb();
		sinAncla.parametros.properties.recurso.pattern = '[A-Za-z]';
		expect(errores(sinAncla)).not.toEqual([]);
		const conEnum = smb();
		conEnum.parametros.properties.recurso = { type: 'string', enum: ['Nominas', 'RRHH'] };
		expect(errores(conEnum)).toEqual([]);
		/* En un texto vale cualquiera: se pinta escapado. */
		const enTexto = credencial();
		delete enTexto.parametros.properties.sesion.pattern;
		enTexto.vias = enTexto.vias.slice(1);
		enTexto.vias[0].carga.pasos[0].orden = 'echo "$SD_USUARIO"';
		enTexto.vias[0].retirada.pasos[0].orden = 'true';
		enTexto.vias[0].comprobacion.prueba.pasos[1].orden = 'ssh "$SD_USUARIO@$SD_OBJETIVO_DIRECCION"';
		expect(errores(enTexto)).toEqual([]);
	});

	it('un ejecutor con el formato malo', () => {
		for (const ejecutor of ['Manual@1', 'manual', 'manual@0', 'manual@12345', '@1', 'a b@1']) {
			const m = smb();
			m.vias[1].ejecutor = ejecutor;
			expect(errores(m), ejecutor).toContain(
				'/vias/1/ejecutor must match pattern "^[a-z][a-z0-9-]{0,31}@[1-9][0-9]{0,3}$"'
			);
		}
	});

	it('la fuente trampa sin un parámetro con x-trampa', () => {
		const m = credencial();
		delete m.parametros.properties.objetivo['x-trampa'];
		const e = errores(m);
		expect(e).toContain(
			'vias[0] (windows): senal.fuente.trampa: ${objetivo} no es un parámetro con x-trampa'
		);
		expect(e).toContain(
			'vias[0] (windows): carga.pasos[0].texto: ${objetivo.direccion}: objetivo no es un parámetro con x-trampa'
		);
		const otro = credencial();
		otro.vias[0].senal.fuente.trampa = '${usuario}';
		expect(errores(otro)).toEqual([
			'vias[0] (windows): senal.fuente.trampa: ${usuario} no es un parámetro con x-trampa'
		]);
	});

	it('x-trampa solo en parámetros de texto', () => {
		const m = credencial();
		m.parametros.properties.objetivo.type = 'integer';
		expect(errores(m)).toContain(
			'parametros.objetivo: x-trampa solo vale en un parámetro type: string'
		);
	});

	it('x-aleatorio con default o con bases que no cumplen el pattern', () => {
		const conDefault = credencial();
		conDefault.parametros.properties.usuario.default = 'svc_backup';
		expect(errores(conDefault)).toEqual([
			'parametros.usuario: x-aleatorio no admite default (la consola propone un valor distinto en cada trampa)'
		]);
		const conEspacio = credencial();
		conEspacio.parametros.properties.usuario['x-aleatorio'].bases.push('svc backup');
		expect(errores(conEspacio)).toEqual([
			'parametros.usuario: x-aleatorio: la base svc backup con 3 caracteres al azar no cumple el parámetro (p. ej. svc backupaaa)'
		]);
		/* El pattern admite 32 caracteres: una base de 30 con 3 al azar se pasa. */
		const larga = credencial();
		larga.parametros.properties.usuario['x-aleatorio'].bases = ['a'.repeat(30)];
		expect(errores(larga)).toHaveLength(1);
		/* Solo letras: el alfabeto por defecto trae dígitos. */
		const letras = credencial();
		letras.parametros.properties.sesion.pattern = '^[a-z-]{1,40}$';
		expect(errores(letras)[0]).toContain('parametros.sesion: x-aleatorio: la base srv-backup');
		const enEntero = credencial();
		enEntero.parametros.properties.usuario = {
			type: 'integer',
			'x-aleatorio': { bases: ['1'], sufijo: 2 }
		};
		expect(errores(enEntero)).toContain(
			'parametros.usuario: x-aleatorio solo vale en un parámetro type: string'
		);
	});

	it('un parámetro cuyo esquema no compila es un error, no una excepción', () => {
		/* La errata del pattern de un x-aleatorio: falta el ] de la clase. */
		const errata = credencial();
		errata.parametros.properties.usuario.pattern = '^[a-z_][a-z0-9_-{2,31}$';
		const r = leerHoneycosa(JSON.stringify(errata));
		expect(r.ok).toBe(false);
		expect(r.ok ? [] : r.errores).toEqual([
			expect.stringMatching(
				/^parametros\.usuario: el esquema no compila: Invalid regular expression: .*Unterminated character class/
			)
		]);
		/* Igual sin x-aleatorio, y con un pattern que no es texto: validarParametros lanzaría al dar de alta. */
		const otro = credencial();
		otro.parametros.properties.sesion = { type: 'string', pattern: '^(a$' };
		otro.parametros.properties.objetivo.pattern = 5;
		expect(errores(otro)).toEqual([
			expect.stringMatching(
				/^parametros\.objetivo: el esquema no compila: .*pattern must be string/
			),
			expect.stringMatching(
				/^parametros\.sesion: el esquema no compila: Invalid regular expression/
			)
		]);
	});

	it('contenedor@1 sin su carga de v1, con otra fuente o sin siembra de servicio', () => {
		const sinAislamiento = smb();
		delete sinAislamiento.vias[0].carga.aislamiento;
		expect(errores(sinAislamiento)).toContain(
			"/vias/0/carga must have required property 'aislamiento'"
		);
		const otraFuente = smb();
		otraFuente.vias[0].senal.fuente = { tipo: 'registros', canal: 'syslog' };
		expect(errores(otraFuente)).toEqual([
			'vias[0] (contenedor): contenedor@1 exige la fuente fichero (el sensor lee los registros del contenedor)'
		]);
		const fichero = smb();
		fichero.siembra.clase = 'fichero';
		expect(errores(fichero)).toEqual([
			'vias[0] (contenedor): contenedor@1 solo vale con siembra.clase servicio (el sensor la recibe como trampa de tipo contenedor)'
		]);
	});

	it('lo de v1 dentro de una vía se valida igual que hoy', () => {
		const m = smb();
		m.vias[0].carga.contenedor.puertos[0].interno = 445;
		m.vias[0].carga.contenedor.entorno.SD_GLUTTON_DOMINIO = '${inventado}';
		m.vias[1].senal.eventos.contrasena = 'Password';
		expect(errores(m)).toEqual([
			'vias[0] (contenedor): carga: contenedor.puertos: el interno 445/tcp tiene que ser 1024 o más (dentro del contenedor la trampa corre sin privilegios); el puerto que ve el atacante es «expuesto»',
			'vias[0] (contenedor): carga: ${inventado} no es un parámetro declarado',
			'vias[1] (carpeta-auditada): senal.eventos.contrasena: Password tiene que estar en detalle'
		]);
		/* En la carga del contenedor no hay variables de contexto: el sensor solo conoce los parámetros. */
		const contexto = smb();
		contexto.vias[0].carga.contenedor.entorno.SD_GLUTTON_EQUIPO = '${destino.nombre}';
		expect(errores(contexto)).toEqual([
			'vias[0] (contenedor): carga: ${destino.nombre} no es un parámetro declarado'
		]);
		const raizMal = smb();
		raizMal.senal.eventos.contrasena = 'clave';
		expect(errores(raizMal)).toEqual([
			'senal.eventos.contrasena: clave tiene que estar en detalle'
		]);
		const imagen = smb();
		imagen.vias[0].carga.contenedor.imagen = 'sugardaddy-trampa-smb:1.0.1';
		expect(errores(imagen)).not.toEqual([]);
	});

	it('las fuentes fichero y registros necesitan un traductor', () => {
		const m = smb();
		delete m.senal.eventos;
		delete m.vias[1].senal.eventos;
		expect(errores(m)).toEqual([
			'vias[0] (contenedor): la fuente fichero necesita un traductor (senal.eventos en la vía o en la raíz)',
			'vias[1] (carpeta-auditada): la fuente registros necesita un traductor (senal.eventos en la vía o en la raíz)'
		]);
		const conElDeLaRaiz = smb();
		delete conElDeLaRaiz.vias[1].senal.eventos;
		expect(errores(conElDeLaRaiz)).toEqual([]);
	});

	it('requisitos con un solo operador y con sus niveles coherentes', () => {
		const dos = smb();
		dos.vias[1].requisitos[0].en = ['windows'];
		expect(errores(dos)).not.toEqual([]);
		const ninguno = smb();
		delete ninguno.vias[1].requisitos[0].igual;
		expect(errores(ninguno)).not.toEqual([]);
		const sinMotivo = smb();
		delete sinMotivo.vias[1].requisitos[0].motivo;
		expect(errores(sinMotivo)).not.toEqual([]);
		const descarta = smb();
		Object.assign(descarta.vias[1].requisitos[1], { nivel: 'avisa', siFalta: 'descarta' });
		expect(errores(descarta)).toEqual([
			'vias[1] (carpeta-auditada): requisitos[1] (shell.powershell): siFalta: descarta solo vale con nivel: exige'
		]);
		const minimo = smb();
		minimo.vias[1].requisitos[1].minimo = '5.1-preview';
		expect(errores(minimo)).not.toEqual([]);
	});

	it('con lenguaje ninguno, los pasos solo llevan texto', () => {
		const m = smb();
		m.vias[1].carga.lenguaje = 'ninguno';
		expect(errores(m)).toEqual([
			'vias[1] (carpeta-auditada): con lenguaje ninguno los pasos solo llevan texto (ni orden ni comprobar)'
		]);
		const panel = smb();
		panel.vias[1].carga = {
			lenguaje: 'ninguno',
			pasos: [{ texto: 'En el panel del NAS, comparte ${ruta}.' }]
		};
		panel.vias[1].retirada.pasos = [{ texto: 'En el panel del NAS, deja de compartir ${ruta}.' }];
		expect(errores(panel)).toEqual([]);
	});

	it('la raíz no admite los campos de v1 ni una versión desconocida', () => {
		for (const [campo, valor] of [
			['tipo', 'contenedor'],
			['eventos', {}],
			['sensorMinimo', '0.13.0'],
			['contenedor', {}]
		] as [string, unknown][]) {
			const m = smb();
			m[campo] = valor;
			expect(errores(m), campo).toContain('/ must NOT have additional properties');
		}
		const sinVias = smb();
		sinVias.vias = [];
		expect(errores(sinVias)).not.toEqual([]);
		expect(errores({ ...smb(), version: 3 })).not.toEqual([]);
	});

	it('la carga de un ejecutor desconocido, como mucho 64 KB', () => {
		const m = smb();
		m.vias.push({
			id: 'servicio',
			ejecutor: 'servicio@1',
			carga: { binario: 'x'.repeat(70000) },
			senal: { fuente: { tipo: 'fichero', ruta: 'smb.json' } },
			retirada: { tipo: 'automatica' }
		});
		expect(errores(m)).toEqual(['vias[2] (servicio): la carga de servicio@1 pasa de 64 KB']);
	});
});

describe('manifiesto v2: lo que vale', () => {
	it('una vía servicio@1 con carga cualquiera', () => {
		const m = smb();
		m.vias.unshift({
			id: 'servicio',
			nombre: 'Como proceso del agente',
			ejecutor: 'servicio@1',
			carga: { binario: 'smb', version: '1.0.0', puertos: [445], lo: { que: ['sea', 1, true] } },
			senal: { fuente: { tipo: 'fichero', ruta: 'smb.json' } },
			retirada: { tipo: 'automatica' }
		});
		const h = honeycosa(m);
		expect(h.vias.map((v) => v.ejecutor)).toEqual(['servicio@1', 'contenedor@1', 'manual@1']);
		expect(h.vias[0].carga).toEqual(m.vias[0].carga);
		expect(() => proyectarParaSensor(h, 'servicio')).toThrow('contenedor@1');
	});

	it('las fuentes que aún no tienen pieza se pueden declarar ya', () => {
		const m = credencial();
		m.vias[0].senal = { fuente: { tipo: 'conector', conexion: 'graph' } };
		m.vias[1].senal = {
			fuente: { tipo: 'rele' },
			eventos: smb().senal.eventos
		};
		expect(errores(m)).toEqual([]);
		const mala = credencial();
		mala.vias[0].senal = { fuente: { tipo: 'conector', conexion: 'okta' } };
		expect(errores(mala)).not.toEqual([]);
		const sobra = credencial();
		sobra.vias[0].senal.fuente.ruta = 'x.json';
		expect(errores(sobra)).not.toEqual([]);
	});

	it('variables de contexto y del objetivo en textos y órdenes', () => {
		const m = credencial();
		m.vias[1].carga.pasos[0].texto =
			'En ${destino.nombre} (${destino.direccion}), trampa ${trampa.nombre} (${trampa.id}), hacia ${objetivo.direccion}:${objetivo.puertoSsh}.';
		m.vias[1].carga.pasos[0].orden =
			'echo "$SD_TRAMPA_ID $SD_TRAMPA_NOMBRE $SD_DESTINO_NOMBRE $SD_DESTINO_DIRECCION $SD_OBJETIVO_DIRECCION $SD_OBJETIVO_PUERTOSSH"';
		m.vias[0].carga.pasos[0].orden =
			'Write-Output $sd.trampa_id $sd.trampa_nombre $sd.destino_nombre $sd.destino_direccion $sd.objetivo_direccion $sd.objetivo_puertoSsh';
		expect(errores(m)).toEqual([]);
	});
});

describe('variablesDeVia', () => {
	/* Lo que lleva el bloque de variables de los pasos generados (§6.3, paso 4). */
	const distintas = (h: Honeycosa, via: number) => {
		const { usos, fallos } = variablesDeVia(h.vias[via], h.parametros);
		expect(fallos).toEqual([]);
		return [...new Set(usos.map((u) => JSON.stringify(u.variable)))].map((v) => JSON.parse(v));
	};

	it('dice a qué se refiere cada nombre de la vía, en el orden en que sale', () => {
		const h = honeycosa(credencial());
		/* En sh el campo del objetivo llega en mayúsculas: solo la trampa objetivo dice cómo se escribe. */
		expect(distintas(h, 1)).toEqual([
			{ de: 'parametro', parametro: 'sesion' },
			{ de: 'objetivo-direccion', parametro: 'objetivo' },
			{ de: 'parametro', parametro: 'usuario' },
			{ de: 'objetivo', parametro: 'objetivo', campo: 'PUERTOSSH', exacto: false },
			{ de: 'contexto', nombre: 'destino.nombre' },
			{ de: 'nonce' }
		]);
		expect(distintas(h, 0)).toContainEqual({
			de: 'objetivo',
			parametro: 'objetivo',
			campo: 'puertoSsh',
			exacto: true
		});
		const { usos } = variablesDeVia(h.vias[1], h.parametros);
		expect(usos[0]).toMatchObject({
			forma: 'texto',
			nombre: 'sesion',
			donde: 'carga.pasos[0].texto'
		});
		expect(usos.filter((u) => u.variable.de === 'nonce').every((u) => u.prueba)).toBe(true);
	});

	it('lo que no se resuelve sale en fallos, con el mismo texto que en validarHoneycosa', () => {
		const m = smb();
		m.vias[1].retirada.pasos[0].orden = 'Remove-Item -LiteralPath $sd.carpeta';
		const texto =
			'retirada.pasos[0].orden: $sd.carpeta no es un parámetro declarado ni una variable de contexto';
		expect(variablesDeVia(m.vias[1], m.parametros).fallos).toEqual([texto]);
		expect(errores(m)).toEqual([`vias[1] (carpeta-auditada): ${texto}`]);
	});
});

describe('validarCatalogo', () => {
	const conCredencial = (cambiar: (m: Datos) => void = () => {}) => {
		const m = credencial();
		cambiar(m);
		return [...catalogo(), honeycosa(m)];
	};

	it('el catálogo de modulos/trampas no tiene referencias rotas', () => {
		const todas = catalogo();
		expect(validarCatalogo(todas)).toEqual({ validas: todas, errores: {} });
	});

	it('pasa con credencial-ssh de verdad', () => {
		const todas = conCredencial();
		expect(validarCatalogo(todas)).toEqual({ validas: todas, errores: {} });
	});

	it('falla con un $sd.objetivo_noexiste, y credencial-ssh no entra', () => {
		const todas = conCredencial((m) => {
			m.vias[0].carga.pasos[0].orden += '\nWrite-Output $sd.objetivo_noexiste';
		});
		const r = validarCatalogo(todas);
		expect(r.errores).toEqual({
			'credencial-ssh': [
				'vias[0] (windows): carga.pasos[0].orden: $sd.objetivo_noexiste: cowrie no tiene el parámetro noexiste'
			]
		});
		expect(r.validas.map((h) => h.id)).toEqual(trampas);
	});

	it('también en sh y en los textos', () => {
		const r = validarCatalogo(
			conCredencial((m) => {
				m.vias[1].carga.pasos[0].orden = 'echo "$SD_OBJETIVO_PUERTO"';
				m.vias[1].carga.pasos[0].texto = 'Hacia ${objetivo.puerto_ssh}.';
			})
		);
		expect(r.errores['credencial-ssh']).toEqual([
			'vias[1] (linux): carga.pasos[0].texto: ${objetivo.puerto_ssh}: cowrie no tiene el parámetro puerto_ssh',
			'vias[1] (linux): carga.pasos[0].orden: SD_OBJETIVO_PUERTO: cowrie no tiene el parámetro PUERTO'
		]);
	});

	it('falla si cowrie deja de tener puertoSsh o deja de poder ir en una orden', () => {
		const sin = catalogo().map((h) => {
			if (h.id !== 'cowrie') return h;
			const { puertoSsh, ...resto } = h.parametros.properties;
			expect(puertoSsh).toBeTruthy();
			return { ...h, parametros: { ...h.parametros, properties: resto } };
		});
		const r = validarCatalogo([...sin, honeycosa(credencial())]);
		expect(r.errores['credencial-ssh']).toContain(
			'vias[0] (windows): carga.pasos[0].orden: $sd.objetivo_puertoSsh: cowrie no tiene el parámetro puertoSsh'
		);
		const libre = catalogo().map((h) =>
			h.id !== 'cowrie'
				? h
				: {
						...h,
						parametros: {
							...h.parametros,
							properties: { ...h.parametros.properties, puertoSsh: { type: 'string' } }
						}
					}
		);
		expect(
			validarCatalogo([...libre, honeycosa(credencial())]).errores['credencial-ssh']
		).toContain(
			'vias[1] (linux): carga.pasos[0].orden: SD_OBJETIVO_PUERTOSSH: cowrie.puertoSsh no es numérico ni declara un enum o un pattern anclado (^…$)'
		);
	});

	it('un v1 con un x-trampa o un parámetro raros no hace lanzar: en v1 nada apunta a otro módulo', () => {
		/* El esquema de v1 no mira los parámetros por dentro: estos pasan leerHoneycosa. */
		const cowrie = leer('modulos/trampas/cowrie/trampa.yaml');
		const yaml = cowrie.replace(
			/^parametros:\n(?: {2}.*\n)*? {2}properties:\n/m,
			(t) => `${t}    raro: { type: string, x-trampa: true }\n    nulo: null\n`
		);
		expect(yaml).not.toBe(cowrie);
		const h = leerHoneycosa(yaml);
		if (!h.ok) throw new Error(h.errores.join('\n'));
		expect(h.valor.parametros.properties).toHaveProperty('raro');
		const todas = [...catalogo().filter((x) => x.id !== 'cowrie'), h.valor];
		expect(validarCatalogo(todas)).toEqual({ validas: todas, errores: {} });
	});

	it('un módulo que hace lanzar la comprobación no entra, y el resto sí', () => {
		/* Lo que validarHoneycosa no dejaría pasar: una honeycosa a mano. */
		const rara = { ...honeycosa(credencial()), id: 'rara', vias: null } as unknown as Honeycosa;
		const r = validarCatalogo([...catalogo(), honeycosa(credencial()), rara]);
		expect(r.errores).toEqual({
			rara: [expect.stringMatching(/^no se puede comprobar contra el catálogo: /)]
		});
		expect(r.validas.map((x) => x.id)).toEqual([...trampas, 'credencial-ssh']);
	});

	it('un x-trampa hacia un módulo que no está, y lo que apunta a un módulo que no entra', () => {
		const sinCowrie = catalogo().filter((h) => h.id !== 'cowrie');
		expect(validarCatalogo([...sinCowrie, honeycosa(credencial())]).errores).toEqual({
			'credencial-ssh': ['parametros.objetivo: x-trampa nombra cowrie, que no está en el catálogo']
		});
		/* Una credencial que apunta a otra credencial rota tampoco entra. */
		const rota = credencial();
		rota.vias[0].carga.pasos[0].orden = 'Write-Output $sd.objetivo_noexiste';
		const encadenada = credencial();
		encadenada.id = 'credencial-encadenada';
		encadenada.parametros.properties.objetivo['x-trampa'].modulos = ['credencial-ssh'];
		encadenada.vias[0].carga.pasos[0].orden = 'Write-Output $sd.objetivo_usuario';
		encadenada.vias[0].comprobacion.prueba.pasos = [{ texto: 'Prueba.' }];
		encadenada.vias[1].carga.pasos[0].orden = 'true';
		encadenada.vias[1].comprobacion.prueba.pasos = [{ texto: 'Prueba.' }];
		const r = validarCatalogo([...catalogo(), honeycosa(rota), honeycosa(encadenada)]);
		expect(Object.keys(r.errores).sort()).toEqual(['credencial-encadenada', 'credencial-ssh']);
		expect(r.errores['credencial-encadenada']).toEqual([
			'parametros.objetivo: x-trampa nombra credencial-ssh, que no está en el catálogo'
		]);
	});
});

describe('vías estables (regla 10)', () => {
	const cowrie = () => catalogo().find((h) => h.id === 'cowrie')!;
	const conVia = (cambios: Partial<Honeycosa['vias'][number]>) => {
		const h = cowrie();
		return { ...h, origen: 2 as const, vias: [{ ...h.vias[0], ...cambios }] };
	};

	it('pasar de v1 a v2 con la vía contenedor no rompe nada', () => {
		expect(viasEstables(cowrie(), honeycosa(comoV2(cowrie())))).toEqual([]);
	});

	it('perder la vía contenedor falla; declararla en «antes» lo arregla', () => {
		expect(viasEstables(cowrie(), conVia({ id: 'sensor' }))).toEqual([
			'cowrie: la vía contenedor (contenedor@1) ha desaparecido; si se ha renombrado, la nueva tiene que declarar antes: [contenedor]'
		]);
		expect(viasEstables(cowrie(), conVia({ id: 'sensor', antes: ['contenedor'] }))).toEqual([]);
	});

	it('cambiar de ejecutor falla, aunque se declare en «antes»', () => {
		expect(
			viasEstables(
				cowrie(),
				conVia({ id: 'servicio', ejecutor: 'servicio@1', antes: ['contenedor'] })
			)
		).toEqual([
			'cowrie: la vía contenedor era contenedor@1 y ahora es servicio@1 (en la vía servicio)'
		]);
	});

	it('los «antes» de la versión anterior también se conservan', () => {
		const renombrada = conVia({ id: 'sensor', antes: ['contenedor'] });
		expect(viasEstables(renombrada, conVia({ id: 'agente', antes: ['sensor'] }))).toEqual([
			'cowrie: la vía contenedor (contenedor@1) ha desaparecido; si se ha renombrado, la nueva tiene que declarar antes: [contenedor]'
		]);
		expect(
			viasEstables(renombrada, conVia({ id: 'agente', antes: ['sensor', 'contenedor'] }))
		).toEqual([]);
	});

	it('añadir vías nuevas no rompe nada', () => {
		const conOtra = honeycosa(comoV2(cowrie()));
		conOtra.vias.push({ ...honeycosa(smb()).vias[1] });
		expect(viasEstables(cowrie(), conOtra)).toEqual([]);
	});
});
