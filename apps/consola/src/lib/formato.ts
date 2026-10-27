const hora = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });
const horaSegundos = new Intl.DateTimeFormat('es-ES', {
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit'
});
const dia = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' });

export function haceCuanto(iso: string, ahora = Date.now()): string {
	const min = Math.round((ahora - Date.parse(iso)) / 60_000);
	if (min < 1) return 'ahora';
	if (min < 60) return `hace ${min} min`;
	const h = Math.round(min / 60);
	if (h < 24) return `hace ${h} h`;
	return `hace ${Math.round(h / 24)} d`;
}

/* «A», «B» y «C»: nombres que ha escrito el cliente, entre comillas. */
export function entreComillas(nombres: string[]) {
	const q = nombres.map((n) => `«${n}»`);
	return q.length > 1 ? `${q.slice(0, -1).join(', ')} y ${q.at(-1)}` : q.join('');
}

/*
 * Por qué no se retira (ni se para) una trampa: lo sembrado que apunta a ella
 * (las que reciben su señal, §8.4) dejaría de avisar.
 */
export function recibeSenalDe(dependientes: string[]) {
	const cuales = entreComillas(dependientes);
	const primero = dependientes.length > 1 ? 'retíralas primero' : `retira ${cuales} primero`;
	return `Esta trampa recibe la señal de ${cuales}: ${primero}.`;
}

/* Por qué no se para una trampa: lo sembrado que apunta a ella (§8.4) dejaría de avisar. */
export function noSeParaPor(dependientes: string[]) {
	const cuales = entreComillas(dependientes);
	return dependientes.length > 1
		? `${cuales} apuntan a esta trampa: si la paras, dejarían de avisar. Retíralas primero.`
		: `${cuales} apunta a esta trampa: si la paras, dejaría de avisar. Retírala primero.`;
}

/*
 * Por qué no se cambia un ajuste de una trampa: lo sembrado que apunta a ella
 * se generó con ese valor (§8.4) y dejaría de servir.
 */
export function noSeCambiaPor(dependientes: string[], ajustes: string[]) {
	const cuales = entreComillas(dependientes);
	const que = entreComillas(ajustes);
	const uno = ajustes.length > 1 ? 'esos ajustes' : 'ese ajuste';
	return dependientes.length > 1
		? `${cuales} apuntan a esta trampa con su ${que}: si lo cambias, dejarían de avisar. Retíralas primero o deja ${uno} como estaba.`
		: `${cuales} apunta a esta trampa con su ${que}: si lo cambias, dejaría de avisar. Retírala primero o deja ${uno} como estaba.`;
}

/* «Pasos para Windows» → «pasos para Windows»: el nombre de una forma en mitad de una frase. */
/*
 * Una trampa puesta (colocada o comprobada): solo entonces su «donde» dice
 * dónde escucha. Antes es lo que cuenta su sensor mientras la pone
 * («error: descargando la imagen nueva»), que ya explica su estado.
 */
export const estaPuesta = (estado: string) => estado === 'comprobada' || estado === 'colocada';

export const enFrase = (t: string) => t.charAt(0).toLocaleLowerCase('es') + t.slice(1);

export const horaCorta = (iso: string) => hora.format(new Date(iso));
export const horaLarga = (iso: string) => horaSegundos.format(new Date(iso));
export const diaCorto = (iso: string) => dia.format(new Date(iso));

export const nombreAccion: Record<string, string> = {
	conexion: 'Conexión',
	autenticacion: 'Autenticación',
	comando: 'Comando',
	lectura: 'Lectura',
	escritura: 'Escritura',
	descarga: 'Descarga',
	baliza: 'Baliza',
	otra: 'Otra'
};

export const nombreTipo: Record<string, string> = {
	contenedor: 'Contenedor',
	fichero: 'Fichero',
	token: 'Token',
	identidad: 'Identidad'
};

export const nombreModo: Record<string, string> = {
	automatica: 'Automática',
	aprobacion: 'Con aprobación',
	simulacion: 'Simulación'
};

const regiones = new Intl.DisplayNames('es', { type: 'region' });
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
	tor?: boolean;
};

/* "España · TELEFONICA DE ESPANA S.A.U." */
export const textoGeo = (g: Geo | null | undefined) =>
	g ? [nombrePais(g.pais), g.organizacion].filter(Boolean).join(' · ') : '';
