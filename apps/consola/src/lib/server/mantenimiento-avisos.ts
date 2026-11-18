/*
 * Avisar por las salidas de avisos es de Cloud. En esta edición no hay salidas:
 * una ventana de mantenimiento y su resumen se ven solo en la consola.
 */
import type { AvisoGuardado } from './db/schema';

export function avisarMantenimiento(_a: Omit<AvisoGuardado, 'id' | 'cuando'>) {}
