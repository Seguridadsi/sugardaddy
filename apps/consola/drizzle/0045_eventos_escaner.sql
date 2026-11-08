ALTER TABLE "eventos" ADD COLUMN "escaner" text;--> statement-breakpoint
ALTER TABLE "incidentes_motor" ADD COLUMN "posible_escaner" text;--> statement-breakpoint
CREATE INDEX "eventos_escaner" ON "eventos" USING btree ("escaner","recibido") WHERE "eventos"."escaner" is not null;