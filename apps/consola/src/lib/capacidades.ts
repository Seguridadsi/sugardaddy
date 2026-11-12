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
		'The honeypots on this sensor receive the address of the container engine itself, not that of whoever connects. This usually happens when Docker has iptables disabled or its firewall rules have been deleted. If you have only tested them from the same machine, the warning will clear with the first connection from another machine.',
	'origen.desktop':
		'This sensor runs on Docker Desktop, which forwards connections using its own address: the honeypots never see the address of whoever connects. This is fine for testing; to see the real source, install the sensor on a Linux host with Docker.',
	'origen.wsl':
		'This sensor runs inside WSL2 with NAT networking: Windows forwards connections using its own address and the honeypots do not see the address of whoever connects. To see the real source, set the WSL network to mirrored mode (networkingMode=mirrored) or install the sensor on a Linux host with Docker.',
	'origen.rootless':
		"The container engine runs rootless and its usual way of forwarding ports hides the source. Until a connection arrives with a real address, assume the honeypots see the engine's address."
};

/*
 * Por qué las trampas de un sensor no tienen su disco de tamaño fijo (SEN-4,
 * docs/diseno/discos-trampa.md), según el motivo que da el sensor. Funcionan
 * igual, con la cuota de siempre; lo que se pierde es el tope duro.
 */
const SIN_DISCO: Record<string, string> = {
	'disco.sin-loop':
		"This machine has no loop devices (common in LXC containers, such as Proxmox's), so each honeypot cannot get its own fixed-size disk for its logs and writable folders. To get them, run the sensor on a virtual machine or allow loop devices in the container.",
	'disco.sin-propagacion':
		'The sensor folder does not receive the mounts of the honeypot disks (mount propagation). This happens on machines whose root mount is private, such as some LXC containers, and on sensors installed before this was supported, which get it with their next update if the machine allows it.',
	'disco.sin-permiso':
		'Docker does not let the sensor start the privileged helper that mounts the honeypot disks (for example, rootless Docker or user namespace remapping).',
	'disco.sin-auxiliar':
		'The sensor does not have the helper that mounts the honeypot disks, because it was installed with an earlier configuration. It gets it with its next update; a Community node installed before this version has to be reinstalled.',
	'disco.error': 'The helper that mounts the honeypot disks failed on this machine.'
};
const SIN_DISCO_ENTRETANTO =
	"Meanwhile, the sensor checks the size of each honeypot's folders every 10 seconds and stops any honeypot that exceeds its quota, but between checks a compromised honeypot could fill this machine's disk.";

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
			texto: `${frase(m.error ?? m.codigo)} Until this is fixed, none of the honeypots on this sensor work.`
		});
	}
	const origen = c.hechos['red.ipOrigenReal'];
	if (origen && origen.valor === false) {
		const motivo = origen.motivo ?? 'origen.desconocido';
		avisos.push({
			codigo: motivo,
			gravedad: 'aviso',
			titulo: 'Honeypots do not see the IP of whoever connects',
			texto: `${ORIGEN[motivo] ?? 'The honeypots on this sensor see the address of the container engine itself, not that of whoever connects.'} ${NO_BLOQUEAR}`
		});
	}
	const clone3 = c.hechos['motor.clone3'];
	if (clone3 && clone3.valor === false) {
		avisos.push({
			codigo: clone3.motivo ?? 'clone3.bloqueado',
			gravedad: 'aviso',
			titulo: 'Some honeypots may not start on this engine',
			texto:
				"The container engine on this sensor does not let programs in recent images create threads (it blocks the clone3 call in its seccomp profile). This happens with Docker 20.10 releases before 20.10.10 that lack your distribution's patch. Honeypots that need it will not start and will say so in their status; the others work. Update Docker, or your distribution's docker.io package, and the warning will clear on its own."
		});
	}
	const disco = c.hechos['disco.trampas'];
	if (disco && disco.valor === false) {
		const motivo = disco.motivo ?? 'disco.error';
		avisos.push({
			codigo: motivo,
			gravedad: 'aviso',
			titulo: 'Honeypots on this sensor have no fixed-size disk',
			texto: `${SIN_DISCO[motivo] ?? SIN_DISCO['disco.error']} ${SIN_DISCO_ENTRETANTO}`
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
	"This address belongs to the sensor's container engine itself, not to whoever touched the honeypot. Do not block it.";
