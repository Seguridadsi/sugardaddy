-- Sesiones con huella (plan de fortificación, 0.4): en la tabla va el SHA-256 del
-- id de la cookie, en hex, no el id. Las sesiones abiertas se pasan aquí mismo,
-- así que nadie tiene que volver a entrar por la actualización: la consola nueva
-- calcula la huella del id que trae la cookie de antes y la encuentra.
--
-- Solo se tocan los ids con la forma de antes (43 caracteres base64url); una
-- huella son 64 caracteres hex, así que repetir la migración no cambia nada.
--
-- Volver atrás a una consola anterior sí cierra las sesiones abiertas: esa ya no
-- sabe leer huellas (se vuelve a entrar y ya).
UPDATE "sesiones"
SET "id" = encode(sha256(convert_to("id", 'UTF8')), 'hex')
WHERE "id" ~ '^[A-Za-z0-9_-]{43}$';
