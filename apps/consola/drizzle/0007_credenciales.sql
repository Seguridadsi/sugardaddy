ALTER TABLE "eventos" ADD COLUMN "contrasena" text;--> statement-breakpoint
ALTER TABLE "eventos" ADD COLUMN "alerta" text;--> statement-breakpoint
CREATE INDEX "eventos_contrasena" ON "eventos" USING btree ("contrasena");