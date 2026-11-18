/*
 * «2026-11-17T02:00» escrito en el reloj de una zona, como instante. Lo usan
 * los horarios de los orígenes conocidos (de pago) y las ventanas de
 * mantenimiento (gratis): por eso vive aparte de origenes-horario.ts.
 */
import { ZONA_POR_DEFECTO } from '../fechas';

export function horaLocal(texto: string, zona = ZONA_POR_DEFECTO): Date | null {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(texto)) return null;
	const comoUtc = new Date(`${texto}:00Z`);
	if (Number.isNaN(comoUtc.getTime())) return null;
	/* Lo que marca el reloj de la zona en un instante, como si fuera UTC. */
	const reloj = (d: Date) => {
		const p = Object.fromEntries(
			new Intl.DateTimeFormat('en-GB', {
				timeZone: zona,
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
				hourCycle: 'h23'
			})
				.formatToParts(d)
				.map((x) => [x.type, x.value])
		);
		return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
	};
	/* Dos vueltas: la segunda corrige si el desfase cambia justo ahí (cambio de hora). */
	let d = new Date(comoUtc.getTime() - (reloj(comoUtc) - comoUtc.getTime()));
	d = new Date(comoUtc.getTime() - (reloj(d) - d.getTime()));
	return d;
}
