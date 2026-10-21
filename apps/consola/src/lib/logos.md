# Logotipos de las trampas

En la lista de trampas, el catálogo y la ficha, cada trampa lleva un icono pequeño:

- Si se basa en un honeypot de código abierto que tiene logotipo propio y su licencia deja usarlo, ese logotipo. Va como reconocimiento de dónde sale, no como recomendación del proyecto.
- Si no, el pictograma propio de su tipo de servicio (`/pictogramas/<tipo>.svg`), con el sello de la abeja: la trampa es nuestra. También cuando es código propio de SeguridadSI o cuando no está claro que el logotipo se pueda usar. Los dibuja `marca/` (ver su README) y el tipo de cada módulo lo dice `paquetes/estilo/pictogramas.ts`.
- Si su módulo aún no tiene tipo, la abeja de Sugardaddy (`/abeja-64.webp`).

Si uno no carga, la consola pasa al siguiente.

Nunca se usa el logotipo del servicio que imita la trampa (MySQL, Redis, Docker, Microsoft, Oracle, SAP…). Son marcas registradas y la trampa no es su producto.

Qué logotipo lleva cada trampa lo decide `logos.ts`, aquí al lado, según la procedencia de su manifiesto y el tipo que le da el servidor. Los ficheros están en `apps/consola/static/logos/` y los genera `herramientas/logos-trampas.sh`, que baja cada original de un commit fijo, comprueba su suma y lo reduce a 64 y 192 px. No se retocan a mano.

Este fichero no va en `static/`: todo lo que hay ahí se sirve sin sesión, y esta lista dice en qué proyecto se basa cada trampa, que es justo lo que buscaría un atacante para reconocerlas. En `static/` solo van imágenes (lo comprueba `logos.spec.ts`).

## Los que se usan

### go-pot (trampa `retencion-web`)

- Ficheros: `go-pot-64.webp`, `go-pot-192.webp`, recortados y reducidos sin otros cambios.
- Original: `docs/img/gopher.png` de [ryanolee/go-pot](https://github.com/ryanolee/go-pot), commit `81bceac36171dbe1e03965864ac8b3c8e4a299e0`, SHA-256 `619a3292d4ed7ba36bf0af7b64d9cd4f6d38f4f7e562a4df56997ceadd68ad47`.
- Licencia: [CC0](https://creativecommons.org/publicdomain/zero/1.0/). La prueba es el `README.md` de ese mismo commit, en «Credits», que dice literalmente: «The go pot logo created by `@_iroshi` and is licensed under the CC0 license.» Es el primer commit en que aparece esa frase, y sigue en `main`. Antes de él, la imagen ya era la misma byte a byte, pero el README no decía su licencia. El código de go-pot es MIT (Copyright (c) 2024 Ryan Lee).
- El dibujo parte del gopher de Go, diseño original de Renee French con licencia [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Por eso la ficha de la trampa lo reconoce junto a la procedencia.

## Revisados que llevan su pictograma

| Proyecto                   | Trampas                      | Por qué no lleva su logotipo                                                                                                                                                                          |
| -------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cowrie                     | `cowrie`                     | Tiene logotipo, pero solo está en el repositorio de su web (cowrie/cowrie.github.io), que no tiene licencia. La BSD-3-Clause de Cowrie no lo cubre. Para usarlo, hay que pedir permiso a sus autores. |
| glutton (mushorg)          | `mssql`, `rdp`, `smb`, `vnc` | Su repositorio no trae logotipo.                                                                                                                                                                      |
| DDoSPot (telekom-security) | `dns-ntp`                    | Su repositorio no trae logotipo. Además, no se usa nada con la marca de Telekom.                                                                                                                      |
| Mailoney                   | `correo`                     | Su repositorio no trae logotipo.                                                                                                                                                                      |
| honeyaml                   | `api-interna`                | Su repositorio no trae logotipo.                                                                                                                                                                      |

Revisado el 18 de octubre de 2026.

## Para añadir uno

1. Comprueba que el logotipo está en el repositorio del proyecto o en un sitio con licencia clara, y que esa licencia deja usarlo (CC0, CC BY, MIT, BSD, Apache…). Fija el commit en que la licencia del logotipo ya está escrita, no uno anterior. Si hay dudas, se le pregunta a Kino y, mientras tanto, su pictograma.
2. Añade su URL en un commit fijo y su suma a `LOGOS` de `herramientas/logos-trampas.py`, y lanza `herramientas/logos-trampas.sh`.
3. Añade el proyecto a `LOGOS` de `logos.ts`, con la URL de su procedencia y el texto de reconocimiento que pida la licencia.
4. Apunta aquí de dónde sale, su licencia y su aviso.
