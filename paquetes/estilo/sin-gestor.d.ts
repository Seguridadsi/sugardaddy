export type Campo = {
	etiqueta: 'input' | 'textarea';
	inicio: number;
	fin: number;
	cierre: number;
	atributos: Map<string, { valor: string | true | undefined; de?: number; a?: number }>;
};
export const MARCAS: [string, string | null][];
export function campos(marcado: string): Campo[];
export function decidir(campo: Campo): 'gestor' | 'nada' | 'marcar';
export function marcar(marcado: string): string;
export function sinGestor(): {
	name: string;
	markup(entrada: { content: string; filename?: string }): { code: string } | undefined;
};
