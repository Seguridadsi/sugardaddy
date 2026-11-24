ALTER TABLE "salud_muestras" ADD COLUMN "cola_pendiente" bigint;--> statement-breakpoint
ALTER TABLE "salud_muestras" ADD COLUMN "cola_sin_entregar" integer;--> statement-breakpoint
ALTER TABLE "salud_muestras" ADD COLUMN "cola_descartando" boolean;--> statement-breakpoint
ALTER TABLE "salud_muestras" ADD COLUMN "reloj" integer;