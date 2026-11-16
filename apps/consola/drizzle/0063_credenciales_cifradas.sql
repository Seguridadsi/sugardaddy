-- Credenciales capturadas cifradas (B-09 de la fortificación para banca, §9.3.A).
--
-- Aquí solo se añaden las columnas: cifrar necesita CLAVE_SECRETOS, que está en el
-- .env del nodo y no en la base. Lo hace la consola al arrancar
-- (credenciales.ts, cifrarAnteriores), por lotes y fila a fila en el mismo UPDATE:
-- pone el sobre, la huella y la máscara, enmascara la línea y deja «contrasena» en
-- null. Una fila a medias no existe; repetirlo no toca las ya cifradas.
--
-- Volver atrás: «contrasena» se queda (vacía en lo ya cifrado). Una consola
-- anterior arranca y funciona, pero no ve las contraseñas de lo cifrado (ve la
-- máscara en la línea); al volver a esta, nada se ha perdido. Sin la clave del
-- nodo no se cifra nada y lo de antes sigue como estaba hasta que la tenga.
--
-- El índice de «contrasena» ya no sirve (se agrupa y se busca por la huella).
DROP INDEX IF EXISTS "eventos_contrasena";--> statement-breakpoint
ALTER TABLE "eventos" ADD COLUMN "credencial" text;--> statement-breakpoint
ALTER TABLE "eventos" ADD COLUMN "contrasena_huella" text;--> statement-breakpoint
ALTER TABLE "eventos" ADD COLUMN "contrasena_mascara" text;--> statement-breakpoint
CREATE INDEX "eventos_contrasena_huella" ON "eventos" USING btree ("contrasena_huella") WHERE "eventos"."contrasena_huella" is not null;
