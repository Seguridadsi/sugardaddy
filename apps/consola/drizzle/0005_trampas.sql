ALTER TABLE "senuelos" RENAME TO "trampas";--> statement-breakpoint
ALTER TABLE "trampas" RENAME CONSTRAINT "senuelos_pkey" TO "trampas_pkey";--> statement-breakpoint
ALTER TABLE "trampas" RENAME CONSTRAINT "senuelos_sensor_sensores_id_fk" TO "trampas_sensor_sensores_id_fk";--> statement-breakpoint
ALTER TABLE "eventos" RENAME COLUMN "senuelo" TO "trampa";--> statement-breakpoint
ALTER INDEX "eventos_senuelo" RENAME TO "eventos_trampa";--> statement-breakpoint
ALTER TABLE "reglas" RENAME COLUMN "senuelos" TO "trampas";
