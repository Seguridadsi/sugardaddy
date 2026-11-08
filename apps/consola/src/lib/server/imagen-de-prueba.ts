/*
 * Solo para las pruebas. Las que despliegan redis, dns-ntp o smb miran el plan y el
 * elector, no la imagen. Pero en el árbol de Community esas trampas son de registro y
 * sus imágenes se publican aparte: mientras la etiqueta nueva no esté en ghcr, el
 * manifiesto lleva el digest en ceros y el elector dice «sin publicar». Lo que se prueba
 * no puede depender de eso, o el CI del repositorio público se pondría en rojo.
 */
const EN_CEROS = `sha256:${'0'.repeat(64)}`;
const SIMULADO = `sha256:${'a'.repeat(64)}`;

export const conImagenPublicada = (yaml: string) => yaml.replaceAll(EN_CEROS, SIMULADO);
