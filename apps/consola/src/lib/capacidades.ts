/*
 * Lo que la consola enseña de lo que cada sensor cuenta de su máquina (desde
 * los sensores 0.13.1): su motor de contenedores en una línea y los avisos
 * que el cliente tiene que ver, cada uno con su código estable (fase.causa).
 * Un sensor anterior no cuenta nada y no tiene avisos.
 */
import type { Capacidades, MotorSensor } from '@sugardaddy/contrato';

export type Aviso = {
	codigo: string;
	/* error: ninguna trampa del sensor funciona; aviso: funcionan, pero con algo que saber. */
	gravedad: 'error' | 'aviso';
	titulo: string;
	texto: string;
};

const MODOS: Record<string, string> = {
	rootful: 'con root',
	rootless: 'sin root',
	desktop: 'Docker Desktop',
	wsl: 'WSL2'
};

const TIPOS: Record<string, string> = { docker: 'Docker', podman: 'Podman' };

/* «Docker 27.5.1 · con root · API 1.47», o null si el sensor no lo ha dicho. */
export function resumenMotor(m: MotorSensor | null | undefined): string | null {
	if (!m || m.codigo || (!m.tipo && !m.version)) return null;
	const nombre = [TIPOS[m.tipo ?? ''] ?? m.tipo ?? 'Motor', m.version].filter(Boolean).join(' ');
	return [
		nombre,
		m.modo ? (MODOS[m.modo] ?? m.modo) : null,
		m.arquitectura,
		m.api ? `API ${m.api}` : null
	]
		.filter(Boolean)
		.join(' · ');
}

const FALLOS_MOTOR: Record<string, string> = {
	'motor.inalcanzable': 'El sensor no llega a su motor de contenedores',
	'motor.permiso': 'El sensor no tiene permiso para usar su motor de contenedores',
	'motor.antiguo': 'El motor de contenedores es demasiado antiguo',
	'motor.api': 'El motor de contenedores no contesta como se espera'
};

/*
 * Por qué las trampas no ven la IP de quien se conecta, según el motivo que
 * da el sensor. La IP de esos eventos es la del propio motor: no sirve para
 * saber quién fue ni para bloquearla.
 */
const NO_BLOQUEAR =
	'Los eventos marcados «IP del motor» no dicen quién se conectó: no bloquees esa dirección.';
const ORIGEN: Record<string, string> = {
	'origen.pasarela':
		'A las trampas de este sensor les llega la dirección del propio motor de contenedores, no la de quien se conecta. Suele pasar cuando Docker tiene desactivado iptables o se han borrado sus reglas del cortafuegos. Si solo las has probado desde la misma máquina, el aviso se irá con la primera conexión desde otro equipo.',
	'origen.desktop':
		'Este sensor corre en Docker Desktop, que reenvía las conexiones con su propia dirección: las trampas nunca ven la de quien se conecta. Vale para probar; para ver el origen real, instala el sensor en un Linux con Docker.',
	'origen.wsl':
		'Este sensor corre dentro de WSL2 con la red en NAT: Windows reenvía las conexiones con su propia dirección y las trampas no ven la de quien se conecta. Para ver el origen real, pon la red de WSL en modo espejo (networkingMode=mirrored) o instala el sensor en un Linux con Docker.',
	'origen.rootless':
		'El motor de contenedores corre sin root y su forma habitual de reenviar los puertos no deja ver el origen. Mientras no llegue una conexión con una dirección real, cuenta con que las trampas ven la del motor.'
};

/* El texto del sensor como frase: con mayúscula al principio y punto al final. */
function frase(t: string) {
	const f = t.trim();
	return f.charAt(0).toLocaleUpperCase('es') + f.slice(1) + (/[.…!?]$/.test(f) ? '' : '.');
}

/* Los avisos de un sensor, el más grave primero. */
export function avisosSensor(c: Capacidades | null | undefined): Aviso[] {
	if (!c) return [];
	const avisos: Aviso[] = [];
	const m = c.motor;
	if (m?.codigo) {
		avisos.push({
			codigo: m.codigo,
			gravedad: 'error',
			titulo: FALLOS_MOTOR[m.codigo] ?? 'El sensor no puede usar su motor de contenedores',
			texto: `${frase(m.error ?? m.codigo)} Hasta que se arregle, ninguna trampa de este sensor funciona.`
		});
	}
	const origen = c.hechos['red.ipOrigenReal'];
	if (origen && origen.valor === false) {
		const motivo = origen.motivo ?? 'origen.desconocido';
		avisos.push({
			codigo: motivo,
			gravedad: 'aviso',
			titulo: 'Las trampas no ven la IP de quien se conecta',
			texto: `${ORIGEN[motivo] ?? 'Las trampas de este sensor ven la dirección del propio motor de contenedores, no la de quien se conecta.'} ${NO_BLOQUEAR}`
		});
	}
	const clone3 = c.hechos['motor.clone3'];
	if (clone3 && clone3.valor === false) {
		avisos.push({
			codigo: clone3.motivo ?? 'clone3.bloqueado',
			gravedad: 'aviso',
			titulo: 'Puede que algunas trampas no arranquen en este motor',
			texto:
				'El motor de contenedores de este sensor no deja a los programas de las imágenes recientes crear hilos (bloquea la llamada clone3 en su perfil seccomp). Pasa con Docker 20.10 anterior a la 20.10.10 sin el parche de tu distribución. Las trampas que lo necesitan no arrancarán y lo dirán en su estado; las demás funcionan. Actualiza Docker, o el paquete docker.io de tu distribución, y el aviso se irá solo.'
		});
	}
	if (m?.sinGarantia) {
		avisos.push({
			codigo: 'motor.sin-garantia',
			gravedad: 'aviso',
			titulo: 'Motor de contenedores sin garantía',
			texto: `Este motor ya no habla ninguna versión de su API de las que Sugardaddy tiene comprobadas (usa la ${m.api ?? '?'}). Funciona, pero sin garantía.`
		});
	}
	return avisos;
}

/* Lo que se dice junto a un evento cuya IP es la del motor. */
export const AVISO_IP_MOTOR =
	'Esta dirección es la del propio motor de contenedores del sensor, no la de quien tocó la trampa. No la bloquees.';
