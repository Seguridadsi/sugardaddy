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
	rootful: 'rootful',
	rootless: 'rootless',
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
	'motor.inalcanzable': 'The sensor cannot reach its container engine',
	'motor.permiso': 'The sensor does not have permission to use its container engine',
	'motor.antiguo': 'The container engine is too old',
	'motor.api': 'The container engine does not respond as expected'
};

/*
 * Por qué las trampas no ven la IP de quien se conecta, según el motivo que
 * da el sensor. La IP de esos eventos es la del propio motor: no sirve para
 * saber quién fue ni para bloquearla.
 */
const NO_BLOQUEAR =
	'Events marked "engine IP" do not show who connected: do not block that address.';
const ORIGEN: Record<string, string> = {
	'origen.pasarela':
		'The decoys on this sensor receive the address of the container engine itself, not that of whoever connects. This usually happens when Docker has iptables disabled or its firewall rules have been deleted. If you have only tested them from the same machine, the warning will clear with the first connection from another machine.',
	'origen.desktop':
		'This sensor runs on Docker Desktop, which forwards connections using its own address: the decoys never see the address of whoever connects. This is fine for testing; to see the real source, install the sensor on a Linux host with Docker.',
	'origen.wsl':
		'This sensor runs inside WSL2 with NAT networking: Windows forwards connections using its own address and the decoys do not see the address of whoever connects. To see the real source, set the WSL network to mirrored mode (networkingMode=mirrored) or install the sensor on a Linux host with Docker.',
	'origen.rootless':
		"The container engine runs rootless and its usual way of forwarding ports hides the source. Until a connection arrives with a real address, assume the decoys see the engine's address."
};

/* El texto del sensor como frase: con mayúscula al principio y punto al final. */
function frase(t: string) {
	const f = t.trim();
	return f.charAt(0).toLocaleUpperCase('en') + f.slice(1) + (/[.…!?]$/.test(f) ? '' : '.');
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
			titulo: FALLOS_MOTOR[m.codigo] ?? 'The sensor cannot use its container engine',
			texto: `${frase(m.error ?? m.codigo)} Until this is fixed, none of the decoys on this sensor work.`
		});
	}
	const origen = c.hechos['red.ipOrigenReal'];
	if (origen && origen.valor === false) {
		const motivo = origen.motivo ?? 'origen.desconocido';
		avisos.push({
			codigo: motivo,
			gravedad: 'aviso',
			titulo: 'Decoys do not see the IP of whoever connects',
			texto: `${ORIGEN[motivo] ?? 'The decoys on this sensor see the address of the container engine itself, not that of whoever connects.'} ${NO_BLOQUEAR}`
		});
	}
	const clone3 = c.hechos['motor.clone3'];
	if (clone3 && clone3.valor === false) {
		avisos.push({
			codigo: clone3.motivo ?? 'clone3.bloqueado',
			gravedad: 'aviso',
			titulo: 'Some decoys may not start on this engine',
			texto:
				"The container engine on this sensor does not let programs in recent images create threads (it blocks the clone3 call in its seccomp profile). This happens with Docker 20.10 releases before 20.10.10 that lack your distribution's patch. Decoys that need it will not start and will say so in their status; the others work. Update Docker, or your distribution's docker.io package, and the warning will clear on its own."
		});
	}
	if (m?.sinGarantia) {
		avisos.push({
			codigo: 'motor.sin-garantia',
			gravedad: 'aviso',
			titulo: 'Container engine without support guarantee',
			texto: `This engine no longer speaks any of the API versions that Sugardaddy has verified (it uses ${m.api ?? '?'}). It works, but without a guarantee.`
		});
	}
	return avisos;
}

/* Lo que se dice junto a un evento cuya IP es la del motor. */
export const AVISO_IP_MOTOR =
	"This address belongs to the sensor's container engine itself, not to whoever touched the decoy. Do not block it.";
