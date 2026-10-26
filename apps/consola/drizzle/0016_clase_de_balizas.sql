ALTER TABLE "balizas" ALTER COLUMN "fichero" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "balizas" ALTER COLUMN "nombre" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "balizas" ALTER COLUMN "tipo" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "balizas" ALTER COLUMN "sha256" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "balizas" ADD COLUMN "clase" text DEFAULT 'documento' NOT NULL;