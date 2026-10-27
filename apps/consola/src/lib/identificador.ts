/*
 * El identificador de un sensor o de una trampa, escrito como quiera quien lo
 * da de alta: se guarda en minúsculas, sin tildes y con guiones («Trampa DNS»
 * → «trampa-dns»), como el id de un destino (scripts/destinos.mjs). Si no se
 * escribe ninguno, o solo lleva símbolos, sale del nombre visible.
 */
import { slug } from '../../scripts/destinos.mjs';

/* El id que se guarda; vacío si ni el escrito ni el nombre tienen una letra o un número. */
export const identificador = (escrito: string, nombre: string) => slug(escrito) || slug(nombre);

export const SIN_IDENTIFICADOR = 'Identificador: escribe uno con alguna letra o número.';
