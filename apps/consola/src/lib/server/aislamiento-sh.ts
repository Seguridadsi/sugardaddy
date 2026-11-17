/*
 * El aislamiento de las trampas en la máquina (docs/diseno/aislamiento-trampas.md §4 y
 * §5), en bash: el perfil AppArmor de las trampas y la unidad sd-discos.
 *
 * El mismo bloque va en despliegue/nodo/instalar.sh (entre sus marcas) y en el script del
 * sensor remoto que genera la consola (sensores-remotos.ts): un sensor en otra máquina
 * nace con el mismo aislamiento que el del nodo. aislamiento-sh.spec.ts comprueba que no
 * se separan; el auxiliar «aislar-anfitrion» de cada versión pone lo mismo
 * (sensor/internal/actualizador/aislamiento.go, con su prueba contra instalar.sh).
 *
 * sd_aislar_trampas <fichero .env> <carpeta de datos del sensor> <imagen del sensor>: nada
 * de esto para la instalación; deja TRAMPAS_APPARMOR en el .env si el perfil carga.
 */
import bloque from './aislamiento.sh?raw';

export const AISLAMIENTO_SH: string = bloque;
