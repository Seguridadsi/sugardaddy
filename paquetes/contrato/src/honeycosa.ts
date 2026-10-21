import type {
	CargaContenedor,
	CargaManual,
	ClaseSenal,
	Fuente,
	Honeycosa,
	ManifiestoTrampa,
	Requisito,
	TipoTrampa,
	Traductor,
	Via
} from './tipos.ts';

/*
 * La honeycosa normalizada (docs/diseno/modulo-despliegue.md §2.6). La consola
 * trabaja siempre con la forma v2, venga el YAML en v1 o en v2; los sensores
 * reciben siempre un v1 (proyectarParaSensor). Todo es puro: sin ficheros, red
 * ni reloj, para que lo use igual la consola que el panel.
 */

type FuenteV1 = ManifiestoTrampa['eventos']['fuente'];

/* v1 decía «fuente.tipo: rele | directorio-activo», que ninguna trampa usa. */
function claseDeV1(f: FuenteV1): ClaseSenal {
	if (f.tipo === 'rele') return 'baliza';
	if (f.tipo === 'directorio-activo') return 'registros';
	return 'directa';
}

function fuenteDeV1(f: FuenteV1): Fuente {
	if (f.tipo === 'rele') return { tipo: 'rele' };
	if (f.tipo === 'directorio-activo') return { tipo: 'registros', canal: 'directorio-activo' };
	/* v1 deja la ruta opcional: se conserva tal cual, para que la proyección dé lo mismo. */
	return (f.ruta === undefined ? { tipo: 'fichero' } : { tipo: 'fichero', ruta: f.ruta }) as Fuente;
}

function fuenteParaV1(f: Fuente, donde: string): FuenteV1 {
	if (f.tipo === 'fichero')
		return f.ruta === undefined ? { tipo: 'fichero' } : { tipo: 'fichero', ruta: f.ruta };
	if (f.tipo === 'rele') return { tipo: 'rele' };
	if (f.tipo === 'registros' && f.canal === 'directorio-activo')
		return { tipo: 'directorio-activo' };
	throw new Error(`${donde}: la fuente ${f.tipo} no existe en el manifiesto v1`);
}

/*
 * Lo que pide una vía con el bloque red (docs/diseno/red.md): el hecho
 * red.capa2, que solo informa un sensor capaz de dar a la trampa su propia IP
 * en el segmento del cliente. El motivo es lo que ve el cliente cuando su
 * máquina no puede (Wi-Fi, nube) y el remedio, cómo arreglarlo.
 */
const requisitoIPPropia: Requisito = {
	hecho: 'red.capa2',
	igual: true,
	motivo:
		'Necesita el modo de red «IP propia»: su tráfico es de capa 2 (multidifusión, difusión o el enlace crudo) y no cruza el NAT del puente de Docker.',
	remedio:
		'Instala el sensor en la VLAN a vigilar, con red por cable (no Wi-Fi ni nube) y con un rango de IP propia reservado.'
};

/* Un v1 como honeycosa: su contenedor pasa a ser la vía «contenedor» con contenedor@1. */
export function normalizar(m: ManifiestoTrampa): Honeycosa {
	const {
		version,
		tipo,
		sensorMinimo,
		contenedor,
		red,
		aislamiento,
		eventos,
		fichero,
		token,
		identidad,
		...comun
	} = m;
	const { fuente, ...traductor } = eventos;
	/* fichero, token e identidad de v1 no tienen vía: «modulo.sin-vias». */
	const vias: Via[] =
		tipo === 'contenedor'
			? [
					{
						id: 'contenedor',
						ejecutor: 'contenedor@1',
						...(sensorMinimo ? { sensorMinimo } : {}),
						/*
						 * El modo «IP propia» es un requisito comprobable más del
						 * lenguaje cerrado (§3): la vía solo vale donde el sensor
						 * informa el hecho red.capa2. El requisito lo escribe aquí
						 * el contrato, no el autor del módulo: la vía de un v1 no
						 * tiene requisitos, y el bloque red sí lo pide.
						 */
						requisitos: red ? [requisitoIPPropia] : [],
						carga: {
							contenedor: contenedor!,
							aislamiento: aislamiento!,
							...(red ? { red } : {})
						},
						senal: { fuente: fuenteDeV1(fuente) },
						retirada: { tipo: 'automatica' }
					}
				]
			: [];
	return {
		/* id, nombre, descripcion, ficha, versionModulo, procedencia, parametros */
		...comun,
		version: 2,
		origen: 1,
		siembra: { clase: tipo === 'contenedor' ? 'servicio' : tipo },
		senal: { clase: claseDeV1(fuente), eventos: traductor },
		vias
	};
}

/*
 * La vía con ese id o, si ya no está, la que lo declara en «antes»: una trampa
 * guardada con un id viejo sigue siendo de la vía que lo sustituyó (regla 10).
 */
export function viaDe(h: Honeycosa, id: string): Via | undefined {
	return h.vias.find((v) => v.id === id) ?? h.vias.find((v) => v.antes?.includes(id));
}

/* El trampa.tipo de los eventos: el nombre de hoy en el contrato del evento. */
export function tipoEvento(h: Honeycosa): TipoTrampa {
	return h.siembra.clase === 'servicio' ? 'contenedor' : h.siembra.clase;
}

/*
 * El traductor que vale para los eventos de esa vía: el suyo o, si no trae, el
 * de la raíz. Una vía con la fuente «trampa» no tiene: sus eventos son los de
 * la trampa objetivo, con el traductor de aquella.
 */
export function traductorDe(h: Honeycosa, viaId: string): Traductor | undefined {
	const via = viaDe(h, viaId);
	if (!via || via.senal.fuente.tipo === 'trampa') return undefined;
	return via.senal.eventos ?? h.senal.eventos;
}

/*
 * La ficha que exige v1 (con «instalacion»). La de un v1 sale igual que entró.
 * Un v2 sin «instalacion» se proyecta como automática (la vía que se proyecta
 * es contenedor@1) y, si tiene alguna vía manual@1, con los textos de los
 * pasos de la primera, sin sustituir huecos (como mucho 20, de 500 caracteres).
 */
function fichaParaV1(h: Honeycosa): ManifiestoTrampa['ficha'] {
	if (!h.ficha) return undefined;
	const { instalacion, ...resto } = h.ficha;
	if (instalacion) return h.ficha as ManifiestoTrampa['ficha'];
	const manual = h.vias.find((v) => v.ejecutor === 'manual@1');
	const pasos = manual
		? (manual.carga as CargaManual).pasos
				.slice(0, 20)
				.map((p) => Array.from(p.texto).slice(0, 500).join(''))
		: [];
	return {
		...resto,
		instalacion: { automatica: true, ...(pasos.length ? { manual: pasos } : {}) }
	};
}

/*
 * Regla 10, contra la versión anterior del mismo módulo: cada id que tuvo una
 * vía (el suyo y sus «antes») sigue señalando una vía, como id o en un
 * «antes», y con el mismo ejecutor. Si no, el plan retiraría con
 * modulo.via-desaparecida todas las trampas puestas con ella, en todos los
 * clientes. La usa herramientas/vias-estables.ts en la CI.
 */
export function viasEstables(antes: Honeycosa, ahora: Honeycosa): string[] {
	return antes.vias.flatMap((v) =>
		[v.id, ...(v.antes ?? [])].flatMap((id) => {
			const nueva = viaDe(ahora, id);
			if (!nueva)
				return [
					`${ahora.id}: la vía ${id} (${v.ejecutor}) ha desaparecido; si se ha renombrado, la nueva tiene que declarar antes: [${id}]`
				];
			if (nueva.ejecutor !== v.ejecutor)
				return [
					`${ahora.id}: la vía ${id} era ${v.ejecutor} y ahora es ${nueva.ejecutor} (en la vía ${nueva.id})`
				];
			return [];
		})
	);
}

/*
 * El manifiesto v1 que entiende cualquier sensor (0.8 en adelante) para una vía
 * contenedor@1. Para un módulo v1 devuelve exactamente lo que leyó leerTrampa,
 * con las claves en el mismo orden. Es una copia: quien la recibe puede
 * cambiarla (quitar imagenPublica) sin tocar la honeycosa.
 */
export function proyectarParaSensor(h: Honeycosa, viaId: string): ManifiestoTrampa {
	const via = viaDe(h, viaId);
	if (!via) throw new Error(`${h.id} no tiene la vía ${viaId}`);
	if (via.ejecutor !== 'contenedor@1')
		throw new Error(
			`la vía ${via.id} de ${h.id} es ${via.ejecutor}: a un sensor solo se le manda una contenedor@1`
		);
	const { contenedor, aislamiento, red } = via.carga as CargaContenedor;
	const traductor = traductorDe(h, via.id);
	if (!traductor) throw new Error(`la vía ${via.id} de ${h.id} no tiene traductor`);
	const ficha = fichaParaV1(h);
	return structuredClone({
		version: 1,
		id: h.id,
		nombre: h.nombre,
		descripcion: h.descripcion,
		...(ficha ? { ficha } : {}),
		versionModulo: h.versionModulo,
		...(via.sensorMinimo ? { sensorMinimo: via.sensorMinimo } : {}),
		tipo: tipoEvento(h),
		...(h.procedencia ? { procedencia: h.procedencia } : {}),
		contenedor,
		/* El bloque red va donde lo espera el manifiesto v1: tras contenedor. */
		...(red ? { red } : {}),
		aislamiento,
		parametros: h.parametros,
		eventos: { fuente: fuenteParaV1(via.senal.fuente, `${h.id}/${via.id}`), ...traductor }
	});
}
