# Política de seguridad

## Cómo avisar de una vulnerabilidad

Si encuentras una vulnerabilidad en Sugardaddy, **no abras una incidencia
pública**. Avísanos en privado por una de estas dos vías:

- **El formulario privado de GitHub:** pestaña **Security** de este repositorio
  → **Report a vulnerability**.
- **Correo a contacto@seguridadsi.com**, con «Vulnerabilidad Sugardaddy» en el
  asunto.

Si puedes, cuéntanos:

- la versión (`cat versiones.env` en el nodo) y la pieza: consola, sensor,
  actualizador o una trampa;
- cómo reproducirlo, paso a paso;
- qué impacto crees que tiene.

Aceptamos avisos en español y en inglés.

## Qué hacemos después

- **Acuse de recibo** en un máximo de 5 días laborables.
- **Valoración:** te decimos si lo reproducimos y qué gravedad le damos.
- **Arreglo:** sale en una versión firmada nueva, que el actualizador de cada
  nodo aplica solo.
- **Publicación coordinada:** acordamos contigo cuándo se hace público. Por
  defecto, cuando el arreglo esté publicado o, como tarde, a los 90 días del
  aviso.
- **Crédito:** si quieres, te citamos en el aviso de seguridad.

## Qué versiones reciben arreglos

Solo la **última versión publicada**. Deja el actualizador encendido para
recibirlos.

## Qué no es una vulnerabilidad

Las trampas están hechas para parecer vulnerables: que una trampa acepte
contraseñas débiles, enseñe un banner antiguo o deje «entrar» es su trabajo.

Sí lo es, por ejemplo:

- salir de una trampa al sensor, a la consola o a la máquina;
- saltarse el login de la consola;
- conseguir que un nodo aplique una versión o una configuración sin firma
  válida.

## Lo que te pedimos

Prueba solo en tu propio nodo. No ataques sistemas que no sean tuyos, no
accedas a datos de terceros y no hagas pruebas de denegación de servicio.
