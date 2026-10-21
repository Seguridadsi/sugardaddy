# Operar Sugardaddy Community: desplegar trampas, actualizar y mantener

Una vez instalado el nodo ([INSTALACION.md](INSTALACION.md)), esta guía cubre el
día a día: dónde poner las trampas, cómo probarlas, cómo mantener el nodo al día
y cómo hacer copias de seguridad. Todos los comandos se lanzan desde la carpeta
del nodo (`/opt/sugardaddy` por defecto), en la máquina Linux.

## 1. Desplegar trampas en tu red

Hay dos sitios donde vive una trampa:

### a) En el propio nodo (lo normal)

La mayoría de las trampas son **servicios en contenedor** que corren en el
sensor del nodo, cada una en su puerto. Desde la consola, en **Trampas**:

1. Elige la trampa y el **puerto** por el que la verá el atacante.
2. Guárdala. En segundos pasa a **Activa**.

Para que un atacante las encuentre, conviene que el nodo tenga una **IP creíble
dentro del segmento** donde quieres vigilar (una más entre tus servidores). Si
tienes varias VLAN, pon el nodo con una pata en cada una, o un nodo por sitio.

### b) Cebos sobre sistemas reales (poco a poco)

Además de las trampas en el nodo, puedes sembrar **cebos** en sistemas de verdad
para que el intruso los encuentre al mirar alrededor:

- En un **servidor de ficheros**: comparticiones o documentos que nadie legítimo
  abre.
- En una **web** interna o en **Azure**: entradas, enlaces o credenciales señuelo
  que solo seguiría quien está husmeando.

Hazlo **poco a poco**: empieza por una trampa en el nodo, compruébala, y ve
ampliando. Cada cebo que pongas no debe tener ningún uso legítimo: así, cualquier
toque es señal.

> Los cebos de fichero que **avisan al abrirse** (Word, Excel, PDF) son una
> función de pago; en la edición Community usas las trampas de servicio.

## 2. Probar una trampa

Desde **otro equipo de tu red** (no desde la máquina del nodo, que falsea la IP):

- **SSH (Cowrie):** `ssh -p <puerto> root@<ip-del-nodo>` y prueba una contraseña.
- **Redis:** `redis-cli -h <ip-del-nodo> -p <puerto> CONFIG SET dir /tmp`
- **Login web:** abre `https://<ip-del-nodo>:<puerto>/` en el navegador.

En la consola, **Eventos** tiene que mostrar lo que hiciste, con la IP de origen
y la acción. Las trampas casi no dan falsas alarmas: nadie de tu empresa las usa,
así que **cada aviso merece que lo mires**.

## 3. HTTPS: instalar la CA en los equipos

Si al instalar usaste la **CA propia del nodo**, los navegadores avisarán de
certificado no confiable hasta que instales su raíz. Está en
`/opt/sugardaddy/ca-raiz.crt` (y la consola la sirve en `/ca-raiz.crt`).
Instálala como entidad de certificación de confianza en los equipos desde los
que entres a la consola. Si prefieres evitarlo, instala el nodo con tu propio
certificado (`TLS_MODO=ficheros`, ver [INSTALACION.md](INSTALACION.md)).

## 4. Mantener el nodo al día

El **actualizador** mantiene el nodo en la última versión firmada: comprueba si
hay una versión nueva, baja las imágenes (siempre por digest) y la aplica; si
algo falla al arrancar, **vuelve atrás** a la versión anterior. No tienes que
hacer nada en el día a día.

Para ver en qué versión estás y el estado de los servicios:

```bash
cd /opt/sugardaddy
docker compose --env-file .env --env-file versiones.env ps
cat versiones.env        # la versión aplicada
```

Las versiones van **firmadas**: el nodo no aplica nada que no venga firmado con
la clave de publicación de Sugardaddy, así que una imagen manipulada no entra.

## 5. Copias de seguridad

Haz copias periódicas. Desde la carpeta del nodo:

```bash
cd /opt/sugardaddy
./copia.sh
```

Guarda la base de datos, los secretos (`.env`), las versiones y la CA del HTTPS
en `copias/sugardaddy-<fecha>.tar.enc`, **cifrado** con `clave-copias`.

> **Guarda `clave-copias` FUERA de la máquina.** Sin ella, la copia no se puede
> restaurar. Si pierdes la máquina y la clave, pierdes el nodo.

Automatízalo con cron (una copia cada madrugada, conserva las últimas 14):

```cron
15 3 * * * cd /opt/sugardaddy && ./copia.sh
```

### Restaurar

En una máquina nueva, con la copia y su `clave-copias`:

```bash
cd /opt/sugardaddy
./restaurar.sh copias/sugardaddy-<fecha>.tar.enc
```

Deja el nodo como estaba: trampas, eventos y secretos.

## 6. Ampliar a un plan

Tu catálogo enseña **todo**, también lo de pago, marcado. Cuando quieras avisos a
tu correo/Teams/Slack/SIEM, trampas avanzadas, varias sedes desde un panel o
soporte, [habla con SeguridadSI](https://www.seguridadsi.com): se activa lo
contratado y se enciende en tu consola, sin reinstalar nada.

## 7. Problemas frecuentes

- **Una trampa no arranca:** míralo en **Trampas**; la consola dice el motivo
  (puerto ocupado, imagen que no se pudo bajar, sensor antiguo…).
- **«No se ve la IP del atacante» / trampa degradada:** el motor de contenedores
  esconde el origen (Docker Desktop, WSL, OrbStack). Usa una VM Linux con Docker
  normal.
- **No llegan eventos al atacar:** ¿atacaste desde **otra** máquina? Desde la del
  nodo la IP sale interna. Revisa también que el puerto de la trampa esté abierto
  en el cortafuegos de tu red hasta el nodo.
- **La consola no deja entrar:** revisa la configuración de Entra (tenant, client
  id, secreto y la URI de redirección `.../auth/callback`).
