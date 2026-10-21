import type { Hechos } from './capacidades.ts';
import type { ContextoElector, Destino } from './elector.ts';
import { motivo, type Motivo } from './motivos.ts';
import { puertosPublicados } from './puertos.ts';
import type { CargaContenedor, Fuente, IdEjecutor, Requisito, TipoDestino, Via } from './tipos.ts';

/*
 * Los ejecutores (docs/diseno/modulo-despliegue.md §6): las pocas maneras de
 * poner una honeycosa, escritas una vez. Son código, cambian poco y van
 * versionados como nombre@N (escala.md, principio 4): una vía cuyo ejecutor no
 * está aquí sale descartada con ejecutor.desconocido, sin invalidar el
 * manifiesto. Puro: sin ficheros, red ni reloj.
 */

/* Orden de preferencia del elector: agente < conector < manual. */
export type ClaseEjecutor = 'agente' | 'conector' | 'manual';

export interface Ejecutor {
	id: IdEjecutor;
	/* El nombre de una vía que no trae el suyo. */
	nombre: string;
	clase: ClaseEjecutor;
	/* Dónde se ejecuta: en el agente del destino o en la propia consola. */
	corre: 'agente' | 'consola';
	/* Tipos de destino donde vale, si la vía no dice otros. */
	destinos: TipoDestino[];
	/* Fuentes de señal que admite. */
	fuentes: Fuente['tipo'][];
	/* Se suman a los de cada vía (antes que ellos). */
	requisitos: Requisito[];
	/* «Parar» tiene sentido. */
	pausable: boolean;
	retirada: 'automatica' | 'confirmada';
	/*
	 * Comprobaciones propias de la carga (imagen, puertos…), con los parámetros
	 * de la trampa. Puras. En modo sondeo el elector pasa a aviso lo que es de
	 * puertos (puertos.*): con otro puerto, la vía valdría.
	 */
	comprobar?: (
		v: Via,
		p: Record<string, unknown>,
		d: Destino,
		c: ContextoElector
	) => { motivos: Motivo[]; avisos: Motivo[] };
}

/* Una lista de textos de los hechos, o vacía si no está o no es una lista. */
function lista(hechos: Hechos, clave: string): string[] {
	const v = Object.hasOwn(hechos, clave) ? hechos[clave]?.valor : undefined;
	return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

/* Un digest en ceros: la imagen aún no se ha publicado (la dejan así los módulos nuevos). */
const SIN_PUBLICAR = /@sha256:0{64}$/;

/*
 * Lo que hoy hacen plan() y choquesDePuertos() en la consola, con código:
 * imagen sin publicar, imagen privada para un sensor sin credencial y choques
 * de puertos con el destino, con la consola y con otras trampas.
 */
function comprobarContenedor(
	v: Via,
	p: Record<string, unknown>,
	d: Destino,
	c: ContextoElector
): { motivos: Motivo[]; avisos: Motivo[] } {
	const { contenedor } = v.carga as CargaContenedor;
	const motivos: Motivo[] = [];
	if (SIN_PUBLICAR.test(contenedor.imagen)) motivos.push(motivo('carga.imagen-sin-publicar'));
	/* Sin el hecho (sensor que no lo dice) se manda, como hoy con la cabecera. */
	const privado = Object.hasOwn(d.hechos, 'registro.privado')
		? d.hechos['registro.privado']?.valor
		: undefined;
	if (!contenedor.imagenPublica && privado === false) motivos.push(motivo('carga.sin-credencial'));
	const reservados = lista(d.hechos, 'puertos.reservados');
	const ocupados = lista(d.hechos, 'puertos.ocupados');
	for (const x of puertosPublicados({ contenedor }, p)) {
		const clave = `${x.protocolo}/${x.puerto}`;
		const datos = { puerto: x.puerto, proto: x.protocolo.toUpperCase(), destino: d.nombre };
		if (reservados.includes(clave))
			motivos.push(motivo('puertos.reservado', datos, { valor: clave }));
		if (ocupados.includes(clave)) motivos.push(motivo('puertos.ocupado', datos, { valor: clave }));
		for (const o of c.trampasDelDestino)
			if (o.puertos.some((y) => y.puerto === x.puerto && y.protocolo === x.protocolo))
				motivos.push(
					motivo('puertos.otra-trampa', { ...datos, nombre: o.nombre }, { valor: clave })
				);
	}
	return { motivos, avisos: [] };
}

const TODOS: TipoDestino[] = [
	'maquina',
	'fileserver',
	'web',
	'paas-web',
	'hosting',
	'dominio',
	'tenant',
	'saas',
	'otro'
];

function congelar<T>(x: T): T {
	if (typeof x === 'object' && x !== null && !Object.isFrozen(x)) {
		Object.freeze(x);
		Object.values(x).forEach(congelar);
	}
	return x;
}

/* Los que conoce esta consola (§6.2 y §6.3). */
export const EJECUTORES: Readonly<Record<string, Ejecutor>> = congelar({
	/*
	 * El de hoy: la trampa corre en un contenedor del sensor de esa máquina, y
	 * el sensor recibe la proyección v1 de la vía. Exige Docker con root y la
	 * IP real del atacante (despliegue-y-control: «la trampa tiene que ver la
	 * IP real»). Los sensores 0.12 y 0.13 no dicen nada de su motor: sin dato,
	 * no se descarta (siFalta: ignora), para que sigan recibiendo sus trampas.
	 */
	'contenedor@1': {
		id: 'contenedor@1',
		nombre: 'En un sensor',
		clase: 'agente',
		corre: 'agente',
		destinos: ['maquina', 'fileserver', 'web'],
		fuentes: ['fichero'],
		requisitos: [
			{
				hecho: 'motor.modo',
				en: ['rootful'],
				siFalta: 'ignora',
				motivo:
					'Docker Desktop, Docker dentro de WSL y Docker o Podman sin root no dejan ver la IP del atacante.',
				remedio:
					'Pon el sensor en un Linux con Docker con root o en la appliance de Hyper-V o VMware.'
			},
			{
				hecho: 'motor.arquitectura',
				en: ['amd64'],
				siFalta: 'ignora',
				motivo: 'Las imágenes de las trampas solo existen para amd64.'
			},
			{
				/* Aún no ha llegado nada: hace falta una trampa puesta para saberlo. */
				hecho: 'red.ipOrigenReal',
				igual: true,
				siFalta: 'ignora',
				motivo:
					'Las trampas de esta máquina ven la IP del motor de contenedores, no la del atacante.',
				remedio:
					'Si solo has probado desde la propia máquina, prueba una de sus trampas desde otro equipo («Probar»): el aviso se va con la primera IP de fuera. Si no, revisa que Docker tenga iptables activado.'
			},
			{
				hecho: 'motor.codigo',
				presente: false,
				nivel: 'avisa',
				motivo: 'El motor de contenedores falla ahora; la trampa esperará a que vuelva.'
			}
		],
		pausable: true,
		retirada: 'automatica',
		comprobar: comprobarContenedor
	},
	/*
	 * Pasos que genera la consola para ese destino y que ejecuta el cliente
	 * (manual.ts, paso 4). Nadie lee un fichero en un destino sin agente: la
	 * señal vuelve por otra trampa, por registros, por el relé o por un
	 * conector. Una credencial sembrada en un servidor no se pausa.
	 */
	'manual@1': {
		id: 'manual@1',
		nombre: 'Pasos a mano',
		clase: 'manual',
		corre: 'consola',
		destinos: TODOS,
		fuentes: ['trampa', 'registros', 'rele', 'conector'],
		requisitos: [],
		pausable: false,
		retirada: 'confirmada'
	}
} satisfies Record<string, Ejecutor>);
