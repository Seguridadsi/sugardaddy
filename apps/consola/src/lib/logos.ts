import type { ManifiestoTrampa } from '@sugardaddy/contrato';
import type { TipoDeServicio } from '@sugardaddy/estilo/pictogramas';

type Procedencia = NonNullable<ManifiestoTrampa['procedencia']>;

/*
 * El icono de cada trampa en la lista, el catálogo y la ficha, según la
 * procedencia de su manifiesto (que no se toca para esto) y su tipo de
 * servicio:
 *
 * - si se basa en un honeypot de código abierto con logotipo propio y su
 *   licencia deja usarlo, ese logotipo, como reconocimiento de dónde sale;
 * - si no (código propio de SeguridadSI, un proyecto sin logotipo o uno que
 *   no está claro que se pueda usar), el pictograma propio de su tipo de
 *   servicio, con el sello de la abeja: es nuestra;
 * - y si su módulo no tiene tipo (uno nuevo que aún no está en el mapa de
 *   @sugardaddy/estilo/pictogramas), la abeja de Sugardaddy.
 *
 * Nunca el logotipo del servicio que imita (MySQL, Redis, Microsoft…): es una
 * marca registrada y la trampa no es su producto. Los logotipos están en
 * static/logos/; su origen, licencia y aviso, en logos.md, aquí al lado (no
 * en static/, que se sirve sin sesión y diría en qué se basa cada trampa). Los
 * pictogramas, en static/pictogramas/, los dibuja y los copia marca/preparar.sh.
 *
 * El tipo lo calcula el servidor (tipoDeServicio) y llega a la página ya
 * resuelto: el mapa nombra cada módulo y no debe ir en el JavaScript. Por eso
 * de @sugardaddy/estilo/pictogramas aquí solo se importa el tipo.
 */

export type IconoTrampa = {
	/* De quién es el dibujo: del proyecto en que se basa, el pictograma de su tipo o la abeja. */
	de: 'proyecto' | 'tipo' | 'sugardaddy';
	/*
	 * Rutas dentro de static/. Los logotipos y la abeja, la de 64 px y la de 192
	 * para pantallas densas; el pictograma es un SVG y vale para todas.
	 */
	src: string;
	src2x?: string;
	/* Lo que se lee al pasar por encima. */
	titulo: string;
	/* El reconocimiento que pide la licencia del logotipo, para la ficha. */
	credito?: string;
};

/* Por la URL de la procedencia, sin protocolo, «www.», «.git» ni barra final. */
const LOGOS: Record<string, { proyecto: string; fichero: string; credito: string }> = {
	'github.com/ryanolee/go-pot': {
		proyecto: 'go-pot',
		fichero: 'go-pot',
		credito:
			'Logotipo de go-pot, de @_iroshi (CC0), a partir del gopher de Go de Renee French (CC BY 4.0).'
	}
};

/* El repositorio de Sugardaddy: lo que procede de aquí es código propio. */
const PROPIO = 'github.com/kinomakino/sugardaddy';

export function claveDe(url: string): string | undefined {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return undefined;
	}
	if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
	const sitio = u.hostname.toLowerCase().replace(/^www\./, '');
	const ruta = u.pathname
		.toLowerCase()
		.replace(/\/+$/, '')
		.replace(/\.git$/, '');
	return sitio + ruta;
}

const ABEJA = { src: '/abeja-64.webp', src2x: '/abeja-192.webp' };
export const pictograma = (tipo: TipoDeServicio) => `/pictogramas/${tipo}.svg`;

/*
 * Los iconos que puede llevar una trampa, en orden, del que le toca hasta la
 * abeja: si uno no llega a cargar, LogoTrampa pasa al siguiente. Todos con el
 * mismo título.
 */
export function iconosTrampa(p?: Procedencia | null, tipo?: TipoDeServicio | null): IconoTrampa[] {
	const clave = p ? claveDe(p.url) : undefined;
	const logo = clave === undefined ? undefined : LOGOS[clave];
	const ajena = p && clave !== PROPIO && p.proyecto.trim();
	const titulo = logo
		? `Basada en ${logo.proyecto}, de código abierto`
		: ajena
			? `Trampa de Sugardaddy basada en ${ajena}`
			: 'Trampa de Sugardaddy';
	const iconos: IconoTrampa[] = [];
	if (logo)
		iconos.push({
			de: 'proyecto',
			src: `/logos/${logo.fichero}-64.webp`,
			src2x: `/logos/${logo.fichero}-192.webp`,
			titulo,
			credito: logo.credito
		});
	if (tipo) iconos.push({ de: 'tipo', src: pictograma(tipo), titulo });
	iconos.push({ de: 'sugardaddy', ...ABEJA, titulo });
	return iconos;
}

export const iconoTrampa = (p?: Procedencia | null, tipo?: TipoDeServicio | null) =>
	iconosTrampa(p, tipo)[0];

/* Los ficheros de todos los logotipos del mapa, para comprobar que están. */
export const ficherosDeLogos = () => [
	ABEJA.src,
	ABEJA.src2x,
	...Object.values(LOGOS).flatMap((l) => [
		`/logos/${l.fichero}-64.webp`,
		`/logos/${l.fichero}-192.webp`
	])
];
