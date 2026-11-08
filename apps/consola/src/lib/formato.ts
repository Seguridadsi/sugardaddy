export function haceCuanto(iso: string, ahora = Date.now()): string {
	const min = Math.round((ahora - Date.parse(iso)) / 60_000);
	if (min < 1) return 'just now';
	if (min < 60) return `${min} min ago`;
	const h = Math.round(min / 60);
	if (h < 24) return `${h} h ago`;
	return `${Math.round(h / 24)} d ago`;
}

/* «A», «B» y «C»: nombres que ha escrito el cliente, entre comillas. */
export function entreComillas(nombres: string[]) {
	const q = nombres.map((n) => `"${n}"`);
	return q.length > 1 ? `${q.slice(0, -1).join(', ')} and ${q.at(-1)}` : q.join('');
}

/*
 * Por qué no se retira (ni se para) una trampa: lo sembrado que apunta a ella
 * (las que reciben su señal, §8.4) dejaría de avisar.
 */
export function recibeSenalDe(dependientes: string[]) {
	const cuales = entreComillas(dependientes);
	const primero = dependientes.length > 1 ? 'remove them first' : `remove ${cuales} first`;
	return `This decoy feeds ${cuales}: ${primero}.`;
}

/* Por qué no se para una trampa: lo sembrado que apunta a ella (§8.4) dejaría de avisar. */
export function noSeParaPor(dependientes: string[]) {
	const cuales = entreComillas(dependientes);
	return dependientes.length > 1
		? `${cuales} point to this decoy: if you stop it, they will stop alerting. Remove them first.`
		: `${cuales} points to this decoy: if you stop it, it will stop alerting. Remove it first.`;
}

/*
 * Por qué no se cambia un ajuste de una trampa: lo sembrado que apunta a ella
 * se generó con ese valor (§8.4) y dejaría de servir.
 */
export function noSeCambiaPor(dependientes: string[], ajustes: string[]) {
	const cuales = entreComillas(dependientes);
	const que = entreComillas(ajustes);
	const uno = ajustes.length > 1 ? 'those settings' : 'that setting';
	return dependientes.length > 1
		? `${cuales} point to this decoy using its ${que}: if you change it, they will stop alerting. Remove them first or leave ${uno} as ${ajustes.length > 1 ? 'they were' : 'it was'}.`
		: `${cuales} points to this decoy using its ${que}: if you change it, it will stop alerting. Remove it first or leave ${uno} as ${ajustes.length > 1 ? 'they were' : 'it was'}.`;
}

/* «Pasos para Windows» → «pasos para Windows»: el nombre de una forma en mitad de una frase. */
/*
 * Una trampa puesta (colocada o comprobada): solo entonces su «donde» dice
 * dónde escucha. Antes es lo que cuenta su sensor mientras la pone
 * («error: descargando la imagen nueva»), que ya explica su estado.
 */
export const estaPuesta = (estado: string) => estado === 'comprobada' || estado === 'colocada';

/* Los nombres propios sin otra mayúscula dentro: en una frase siguen como están. */
const NOMBRES_PROPIOS = new Set([
	'Azure',
	'Cloudflare',
	'Cowrie',
	'Docker',
	'Entra',
	'Kerberos',
	'Linux',
	'Microsoft',
	'Redis',
	'Slack',
	'Sophos',
	'Telegram',
	'Ubuntu',
	'Windows'
]);

/*
 * El nombre de una forma, para ir dentro de una frase: la primera letra en
 * minúscula, salvo si la primera palabra es un nombre propio o unas siglas
 * (lleva otra mayúscula, como SSH, KeePass o FortiGate).
 */
export const enFrase = (t: string) => {
	const primera = t.split(/[\s/,:;()]/, 1)[0];
	if (NOMBRES_PROPIOS.has(primera) || /\p{Lu}/u.test(primera.slice(1))) return t;
	return t.charAt(0).toLocaleLowerCase('en') + t.slice(1);
};

/* La severidad se guarda en español (`critica`…); lo que se enseña sale de aquí. */
export const nombreSeveridad = (severidad: string | null | undefined) =>
	({ critica: 'Critical', alta: 'High', media: 'Medium', baja: 'Low' })[severidad ?? ''] ??
	severidad ??
	'';

/* Las notas de triaje que pone el sistema llevan un prefijo guardado: se enseña en inglés. */
export const notaVisible = (nota: string | null | undefined) =>
	(nota ?? '')
		.replace(/^Origen conocido: /, 'Known source: ')
		.replace(/^Modo pentest: /, 'Pentest mode: ');

/*
 * trampas.donde dice dónde escucha, con el marcador «IP propia» que lee el mapa,
 * o lo que está haciendo la consola: valores guardados que se enseñan en inglés.
 */
export const dondeVisible = (donde: string) =>
	donde
		.replace(/^IP propia /, 'Own IP ')
		.replace(/^desplegando…$/, 'deploying…')
		.replace(/^aplicando cambios…$/, 'applying changes…');

export const nombreAccion: Record<string, string> = {
	conexion: 'Connection',
	autenticacion: 'Authentication',
	comando: 'Command',
	lectura: 'Read',
	escritura: 'Write',
	descarga: 'Download',
	baliza: 'Beacon',
	otra: 'Other'
};

export const nombreTipo: Record<string, string> = {
	contenedor: 'Container',
	fichero: 'File',
	token: 'Token',
	identidad: 'Identity'
};

export const nombreModo: Record<string, string> = {
	automatica: 'Automatic',
	aprobacion: 'With approval',
	simulacion: 'Simulation'
};

const regiones = new Intl.DisplayNames('en', { type: 'region' });
/* "ES" → "España". Si el código no es uno conocido, el código tal cual. */
export function nombrePais(codigo: string | null | undefined) {
	if (!codigo) return '';
	try {
		return regiones.of(codigo) ?? codigo;
	} catch {
		return codigo;
	}
}

export type Geo = {
	pais: string | null;
	asn: number | null;
	organizacion: string | null;
	region?: string | null;
	tor?: boolean;
};

/* Las comunidades y ciudades autónomas, por su código de ISO 3166-2:ES. */
export const COMUNIDADES: Record<string, string> = {
	AN: 'Andalucía',
	AR: 'Aragón',
	AS: 'Asturias',
	CB: 'Cantabria',
	CE: 'Ceuta',
	CL: 'Castilla y León',
	CM: 'Castilla-La Mancha',
	CN: 'Canarias',
	CT: 'Cataluña',
	EX: 'Extremadura',
	GA: 'Galicia',
	IB: 'Illes Balears',
	MC: 'Región de Murcia',
	MD: 'Comunidad de Madrid',
	ML: 'Melilla',
	NC: 'Navarra',
	PV: 'País Vasco',
	RI: 'La Rioja',
	VC: 'Comunitat Valenciana'
};

/* "España (Comunidad de Madrid) · TELEFONICA DE ESPANA S.A.U." */
export const textoGeo = (g: Geo | null | undefined) =>
	g
		? [
				nombrePais(g.pais) +
					(g.region && COMUNIDADES[g.region] ? ` (${COMUNIDADES[g.region]})` : ''),
				g.organizacion
			]
				.filter(Boolean)
				.join(' · ')
		: '';
