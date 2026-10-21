package seguidor

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLeeSoloLineasCompletasYSigue(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "log.jsonl")
	if err := os.WriteFile(ruta, []byte("uno\ndos\ntre"), 0o600); err != nil {
		t.Fatal(err)
	}
	lineas, off, err := Leer(ruta, 0)
	if err != nil || len(lineas) != 2 || off != 8 {
		t.Fatalf("lineas=%q off=%d err=%v", lineas, off, err)
	}

	f, _ := os.OpenFile(ruta, os.O_APPEND|os.O_WRONLY, 0)
	_, _ = f.WriteString("s\ncuatro\n")
	f.Close()
	lineas, off, _ = Leer(ruta, off)
	if len(lineas) != 2 || string(lineas[0]) != "tres" || string(lineas[1]) != "cuatro" {
		t.Fatalf("segunda vuelta: %q", lineas)
	}

	// Rotado: el fichero nuevo es más corto que el offset.
	_ = os.WriteFile(ruta, []byte("nuevo\n"), 0o600)
	lineas, _, _ = Leer(ruta, off)
	if len(lineas) != 1 || string(lineas[0]) != "nuevo" {
		t.Fatalf("tras rotar: %q", lineas)
	}
}

func TestFicheroQueAunNoExiste(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "no")
	lineas, off, err := Leer(ruta, 0)
	if err != nil || lineas != nil || off != 0 {
		t.Fatalf("lineas=%q off=%d err=%v", lineas, off, err)
	}
	p := Posicion{Inodo: 7, Offset: 9, Huella: "3:abc"}
	ls, nueva, aviso, err := Seguir(ruta, p)
	if err != nil || ls != nil || nueva != p || aviso != "" {
		t.Fatalf("lineas=%q p=%+v aviso=%q err=%v", ls, nueva, aviso, err)
	}
}

func TestVariasRotacionesSeguidas(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "cowrie.json")
	t0 := hace(24 * time.Hour)
	escribir(t, ruta, "a1\n")
	lineas, p, _ := seguir(t, ruta, Posicion{})
	iguales(t, lineas, "a1")

	// Fin de semana con el sensor parado: tres rotaciones. Con nombres
	// numerados (el .1 es el más nuevo) solo la fecha da el orden.
	escribir(t, ruta, "a2\n")
	rotar(t, ruta, ruta+".3", t0)
	escribir(t, ruta, "b1\nb2\n")
	rotar(t, ruta, ruta+".2", t0.Add(time.Hour))
	escribir(t, ruta, "c1\nc2") // sin salto final: en un rotado cuenta igual
	rotar(t, ruta, ruta+".1", t0.Add(2*time.Hour))
	escribir(t, ruta, "d1\nd")

	lineas, p, aviso := seguir(t, ruta, p)
	iguales(t, lineas, "a2", "b1", "b2", "c1", "c2", "d1")
	if aviso != "" || p.Inodo != inodo(t, ruta) || p.Offset != 3 {
		t.Fatalf("aviso=%q p=%+v", aviso, p)
	}
	// La «d» a medias del activo no se ha dado por buena.
	escribir(t, ruta, "2\n")
	lineas, _, _ = seguir(t, ruta, p)
	iguales(t, lineas, "d2")
}

func TestRotadosEmpatadosSeOrdenanPorNombre(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "cowrie.json")
	t0 := hace(time.Hour)
	escribir(t, ruta, "a1\n")
	_, p, _ := seguir(t, ruta, Posicion{})
	escribir(t, ruta, "a2\n")
	rotar(t, ruta, ruta+".2026_10_14", t0)
	escribir(t, ruta, "b1\n")
	rotar(t, ruta, ruta+".2026_10_15", t0)
	escribir(t, ruta, "c1\n")
	lineas, _, _ := seguir(t, ruta, p)
	iguales(t, lineas, "a2", "b1", "c1")
}

func TestRotadoGrandeEnVariasVueltas(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "cowrie.json")
	t0 := hace(24 * time.Hour)
	escribir(t, ruta, "inicio\n")
	_, p, _ := seguir(t, ruta, Posicion{})

	// Dos rotados de más de 5 MB cada uno sin leer.
	var quiero []string
	rotados := map[uint64]bool{}
	for r := range 2 {
		var b strings.Builder
		for i := range 60000 {
			l := fmt.Sprintf("rotado %d linea %06d %s", r, i, strings.Repeat("x", 80))
			quiero = append(quiero, l)
			b.WriteString(l + "\n")
		}
		escribir(t, ruta, b.String())
		nombre := fmt.Sprintf("%s.%d", ruta, r)
		rotar(t, ruta, nombre, t0.Add(time.Duration(r)*time.Hour))
		rotados[inodo(t, nombre)] = true
	}
	escribir(t, ruta, "nuevo\n")
	quiero = append(quiero, "nuevo")

	var hay []string
	vueltas := 0
	for range 20 {
		lineas, nueva, _ := seguir(t, ruta, p) // y ninguna vuelta pasa de 4 MB
		if len(lineas) == 0 && nueva == p {
			break
		}
		vueltas++
		hay = append(hay, lineas...)
		// A medias, la posición sigue en un rotado: se retoma solo con ella.
		if len(hay) < len(quiero) && !rotados[nueva.Inodo] {
			t.Fatalf("vuelta %d: la posición debería seguir en un rotado: %+v", vueltas, nueva)
		}
		p = nueva
	}
	if vueltas < 3 {
		t.Fatalf("más de 10 MB deberían leerse en varias vueltas: %d", vueltas)
	}
	if len(hay) != len(quiero) {
		t.Fatalf("hay %d líneas, quiero %d", len(hay), len(quiero))
	}
	for i := range quiero {
		if hay[i] != quiero[i] {
			t.Fatalf("línea %d: %q, quiero %q", i, hay[i], quiero[i])
		}
	}
	if p.Inodo != inodo(t, ruta) {
		t.Fatalf("al acabar se sigue el activo: %+v", p)
	}
}

func TestRotacionEntreAbrirYLeer(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "cowrie.json")
	escribir(t, ruta, "a1\n")
	_, p, _ := seguir(t, ruta, Posicion{})
	escribir(t, ruta, "a2\n")
	viejo := inodo(t, ruta)

	// Lo rotan justo después de abrirlo: se lee el que se abrió, con su
	// offset, y la posición queda en él.
	t.Cleanup(func() { trasAbrir = nil })
	trasAbrir = func() {
		trasAbrir = nil
		escribir(t, ruta, "a3\n")
		rotar(t, ruta, ruta+".1", hace(time.Hour))
		escribir(t, ruta, "b1\n")
	}
	lineas, p, _ := seguir(t, ruta, p)
	iguales(t, lineas, "a2")
	if p.Inodo != viejo {
		t.Fatalf("la posición es del fichero que se leyó: %+v", p)
	}
	lineas, _, _ = seguir(t, ruta, p)
	iguales(t, lineas, "a3", "b1")
}

func TestRotanElActivoDespuesDeAbrirlo(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "cowrie.json")
	t0 := hace(24 * time.Hour)
	escribir(t, ruta, "a1\n")
	_, p, _ := seguir(t, ruta, Posicion{})
	escribir(t, ruta, "a2\n")
	rotar(t, ruta, ruta+".1", t0)
	escribir(t, ruta, "b1\n")

	// Mientras se acaba el .1, el activo abierto pasa a ser el .2: se lee una
	// sola vez, como activo, no también como rotado.
	t.Cleanup(func() { trasAbrir = nil })
	trasAbrir = func() {
		trasAbrir = nil
		rotar(t, ruta, ruta+".2", t0.Add(time.Hour))
		escribir(t, ruta, "c1\n")
	}
	lineas, p, _ := seguir(t, ruta, p)
	iguales(t, lineas, "a2", "b1")
	lineas, _, _ = seguir(t, ruta, p)
	iguales(t, lineas, "c1")
}

func TestCarpetaCopiada(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "registros")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	ruta := filepath.Join(dir, "cowrie.json")
	escribir(t, ruta, "a1\na2\n")
	_, p, _ := seguir(t, ruta, Posicion{})
	escribir(t, ruta, "a3\n")

	// rsync -a: el mismo fichero con otro inodo. Se sigue desde el offset.
	copiarCarpeta(t, dir)
	if inodo(t, ruta) == p.Inodo {
		t.Fatal("la copia debería tener otro inodo")
	}
	lineas, p, aviso := seguir(t, ruta, p)
	iguales(t, lineas, "a3")
	if aviso != "" || p.Inodo != inodo(t, ruta) {
		t.Fatalf("aviso=%q p=%+v", aviso, p)
	}

	// Rotado y después copiado: se encuentra el rotado por su huella.
	escribir(t, ruta, "a4\n")
	rotar(t, ruta, ruta+".1", hace(time.Hour))
	escribir(t, ruta, "b1\n")
	copiarCarpeta(t, dir)
	lineas, _, aviso = seguir(t, ruta, p)
	iguales(t, lineas, "a4", "b1")
	if aviso != "" {
		t.Fatalf("aviso=%q", aviso)
	}
}

func TestRotadoBorradoAvisa(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "cowrie.json")
	escribir(t, ruta, "a1\n")
	_, p, _ := seguir(t, ruta, Posicion{})
	escribir(t, ruta, "a2\n")
	rotar(t, ruta, ruta+".1", hace(time.Hour))
	escribir(t, ruta, "b1\n")
	if err := os.Remove(ruta + ".1"); err != nil {
		t.Fatal(err)
	}
	lineas, _, aviso := seguir(t, ruta, p)
	iguales(t, lineas, "b1")
	if aviso != avisoPerdido {
		t.Fatalf("aviso=%q", aviso)
	}
}

func TestLineaGiganteNoAtasca(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "cowrie.json")
	escribir(t, ruta, "a\n"+strings.Repeat("x", maxLectura+maxLectura/4)+"\nb\n")
	lineas, p, avisos := vueltas(t, ruta, Posicion{})
	iguales(t, lineas, "a", "b")
	if len(avisos) != 1 {
		t.Fatalf("avisos=%q", avisos)
	}

	// Aún escribiéndose: se salta el trozo entero, se espera al resto sin
	// atascarse y su cola no se entrega como si fuera una línea.
	escribir(t, ruta, "c\n"+strings.Repeat("y", maxLectura+100))
	lineas, p, avisos = vueltas(t, ruta, p)
	iguales(t, lineas, "c")
	if len(avisos) != 1 {
		t.Fatalf("avisos=%q", avisos)
	}
	escribir(t, ruta, "yy\nd\n")
	lineas, _, _ = vueltas(t, ruta, p)
	iguales(t, lineas, "d")
}

func TestFicheroDispersoNoAtasca(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "cowrie.json")
	f, err := os.Create(ruta)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString("uno\n")
	_, _ = f.Seek(2*maxLectura+1000, io.SeekCurrent) // un hueco de ceros
	_, _ = f.WriteString("dos\ntres\n")
	f.Close()
	lineas, _, avisos := vueltas(t, ruta, Posicion{})
	iguales(t, lineas, "uno", "dos", "tres")
	if len(avisos) != 2 {
		t.Fatalf("avisos=%q", avisos)
	}

	// Un hueco pequeño: se lee de una vez y los ceros no se pegan a la línea.
	f, err = os.Create(ruta)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.Seek(1000, io.SeekStart)
	_, _ = f.WriteString("uno\n")
	f.Close()
	lineas, _, avisos = vueltas(t, ruta, Posicion{})
	iguales(t, lineas, "uno")
	if len(avisos) != 0 {
		t.Fatalf("avisos=%q", avisos)
	}
}

func TestCopytruncate(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "cowrie.json")
	escribir(t, ruta, "a1\na2\n")
	_, p, _ := seguir(t, ruta, Posicion{})
	escribir(t, ruta, "a3\n")

	// logrotate copytruncate: lo copia (otro inodo) y vacía el mismo. Lo que
	// faltaba se acaba en la copia y después se sigue desde 0.
	copiar(t, ruta, ruta+".1")
	fecha(t, ruta+".1", hace(time.Hour))
	if err := os.Truncate(ruta, 0); err != nil {
		t.Fatal(err)
	}
	escribir(t, ruta, "b1\n")
	lineas, p, _ := seguir(t, ruta, p)
	iguales(t, lineas, "a3", "b1")

	// Sin copia y vuelto a llenar hasta el mismo tamaño: lo delata la huella.
	if err := os.Truncate(ruta, 0); err != nil {
		t.Fatal(err)
	}
	escribir(t, ruta, "c1\n")
	lineas, p, _ = seguir(t, ruta, p)
	iguales(t, lineas, "c1")

	// Y vaciado sin más: más corto que el offset, desde 0.
	if err := os.Truncate(ruta, 0); err != nil {
		t.Fatal(err)
	}
	escribir(t, ruta, "d\n")
	lineas, _, _ = seguir(t, ruta, p)
	iguales(t, lineas, "d")
}

func TestEstadoAntiguoSinInodo(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "cowrie.json")
	escribir(t, ruta, "a1\na2\n")
	_, off, _ := Leer(ruta, 0) // lo que guardaba el sensor antes de la 0.12.1
	escribir(t, ruta, "a3\n")
	lineas, p, aviso := seguir(t, ruta, Posicion{Offset: off})
	iguales(t, lineas, "a3")
	if aviso != "" || p.Inodo != inodo(t, ruta) || p.Huella == "" {
		t.Fatalf("aviso=%q p=%+v", aviso, p)
	}
}

func TestRotadoRecienEscritoEspera(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "cowrie.json")
	escribir(t, ruta, "a1\n")
	_, p, _ := seguir(t, ruta, Posicion{})
	// El honeypot aún escribe en el renombrado (no ha abierto el nuevo): su
	// última línea a medias no cuenta y no se pasa al activo.
	escribir(t, ruta, "a2\na")
	if err := os.Rename(ruta, ruta+".1"); err != nil {
		t.Fatal(err)
	}
	escribir(t, ruta, "b1\n")
	lineas, p, _ := seguir(t, ruta, p)
	iguales(t, lineas, "a2")
	if p.Inodo != inodo(t, ruta+".1") {
		t.Fatalf("la posición sigue en el rotado: %+v", p)
	}
	escribir(t, ruta+".1", "3\n")
	fecha(t, ruta+".1", hace(time.Hour))
	lineas, _, _ = seguir(t, ruta, p)
	iguales(t, lineas, "a3", "b1")
}

// La API de la 0.12.1 sigue valiendo con su estado (inodo, sin huella).
func TestLeerRotadoSigueValiendo(t *testing.T) {
	ruta := filepath.Join(t.TempDir(), "cowrie.json")
	escribir(t, ruta, "uno\n")
	lineas, off, ino, err := LeerRotado(ruta, 0, 0)
	if err != nil || len(lineas) != 1 || ino == 0 {
		t.Fatalf("lineas=%q ino=%d err=%v", lineas, ino, err)
	}
	escribir(t, ruta, "dos\ntres\n")
	rotar(t, ruta, ruta+".2026_10_16", hace(time.Hour))
	escribir(t, ruta, "cuatro\n")

	lineas, off, ino2, err := LeerRotado(ruta, off, ino)
	if err != nil {
		t.Fatal(err)
	}
	iguales(t, textos(lineas), "dos", "tres", "cuatro")
	if ino2 == ino || off != 7 {
		t.Fatalf("ahora se sigue el fichero nuevo: ino=%d off=%d", ino2, off)
	}
	lineas, _, _, _ = LeerRotado(ruta, off, ino2)
	if len(lineas) != 0 {
		t.Fatalf("repetidas: %q", lineas)
	}
}

// seguir llama a Seguir, comprueba que no lee más de 4 MB y devuelve las
// líneas como texto.
func seguir(t *testing.T, ruta string, p Posicion) ([]string, Posicion, string) {
	t.Helper()
	lineas, nueva, aviso, err := Seguir(ruta, p)
	if err != nil {
		t.Fatal(err)
	}
	total := 0
	for _, l := range lineas {
		total += len(l) + 1
	}
	if total > maxLectura {
		t.Fatalf("una vuelta ha leído %d bytes", total)
	}
	return textos(lineas), nueva, aviso
}

// vueltas llama a Seguir hasta que deja de avanzar.
func vueltas(t *testing.T, ruta string, p Posicion) ([]string, Posicion, []string) {
	t.Helper()
	var todas, avisos []string
	for range 50 {
		lineas, nueva, aviso := seguir(t, ruta, p)
		if aviso != "" {
			avisos = append(avisos, aviso)
		}
		todas = append(todas, lineas...)
		if len(lineas) == 0 && nueva == p {
			return todas, p, avisos
		}
		p = nueva
	}
	t.Fatal("no deja de avanzar")
	return nil, p, nil
}

func textos(lineas [][]byte) []string {
	var s []string
	for _, l := range lineas {
		s = append(s, string(l))
	}
	return s
}

func iguales(t *testing.T, hay []string, quiero ...string) {
	t.Helper()
	if strings.Join(hay, "|") != strings.Join(quiero, "|") || len(hay) != len(quiero) {
		t.Fatalf("hay %q, quiero %q", hay, quiero)
	}
}

// escribir añade texto al final de ruta (lo crea si no existe).
func escribir(t *testing.T, ruta, texto string) {
	t.Helper()
	f, err := os.OpenFile(ruta, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(texto); err != nil {
		t.Fatal(err)
	}
}

func hace(d time.Duration) time.Time { return time.Now().Add(-d).Truncate(time.Second) }

// rotar renombra el registro como hace el honeypot y le pone una fecha
// pasada: así está quieto y se ordena entre los demás rotados.
func rotar(t *testing.T, de, a string, cuando time.Time) {
	t.Helper()
	if err := os.Rename(de, a); err != nil {
		t.Fatal(err)
	}
	fecha(t, a, cuando)
}

func fecha(t *testing.T, ruta string, cuando time.Time) {
	t.Helper()
	if err := os.Chtimes(ruta, cuando, cuando); err != nil {
		t.Fatal(err)
	}
}

func inodo(t *testing.T, ruta string) uint64 {
	t.Helper()
	fi, err := os.Stat(ruta)
	if err != nil {
		t.Fatal(err)
	}
	ino := InodoDe(fi)
	if ino == 0 {
		t.Skip("este sistema no da inodos")
	}
	return ino
}

// copiar copia un fichero con su fecha.
func copiar(t *testing.T, de, a string) {
	t.Helper()
	b, err := os.ReadFile(de)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(a, b, 0o600); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(de)
	if err != nil {
		t.Fatal(err)
	}
	fecha(t, a, fi.ModTime())
}

// copiarCarpeta hace lo que rsync -a o cp -a: la carpeta queda igual (nombres,
// contenidos y fechas) pero con ficheros de otro inodo. La vieja se aparta,
// no se borra: así sus inodos no se reutilizan.
func copiarCarpeta(t *testing.T, dir string) {
	t.Helper()
	vieja := filepath.Join(t.TempDir(), "vieja")
	if err := os.Rename(dir, vieja); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	entradas, err := os.ReadDir(vieja)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entradas {
		copiar(t, filepath.Join(vieja, e.Name()), filepath.Join(dir, e.Name()))
	}
}

func TestSiFaltaElDeLaPosicionSeLeenLosRotadosDeDetras(t *testing.T) {
	dir := t.TempDir()
	ruta := filepath.Join(dir, "cowrie.json")
	escribe := func(p, s string) { _ = os.WriteFile(p, []byte(s), 0o644) }
	escribe(ruta, "a1\n")
	_, p, _, _ := Seguir(ruta, Posicion{})
	// Dos rotaciones mientras el sensor no lee; alguien borra la primera.
	escribe(ruta, "a1\na2\n")
	_ = os.Rename(ruta, ruta+".2026_10_14")
	time.Sleep(20 * time.Millisecond)
	escribe(ruta+".2026_10_15", "b1\nb2\n")
	_ = os.Chtimes(ruta+".2026_10_15", time.Now().Add(-time.Minute), time.Now().Add(-time.Minute))
	_ = os.Chtimes(ruta+".2026_10_14", time.Now().Add(-2*time.Minute), time.Now().Add(-2*time.Minute))
	escribe(ruta, "c1\n")
	_ = os.Remove(ruta + ".2026_10_14")
	p.Modif = time.Now().Add(-3 * time.Minute).UnixNano()
	lineas, _, aviso, err := Seguir(ruta, p)
	if err != nil {
		t.Fatal(err)
	}
	if aviso == "" || len(lineas) != 3 || string(lineas[0]) != "b1" || string(lineas[2]) != "c1" {
		t.Fatalf("se pierde a2 (avisando), pero b1 y b2 siguen en disco y se leen: %q aviso=%q", lineas, aviso)
	}
}

func TestRotacionDeUnRegistroConCabeceraFija(t *testing.T) {
	dir := t.TempDir()
	ruta := filepath.Join(dir, "registro.csv")
	cab := strings.Repeat("c", 299) + "\n"
	_ = os.WriteFile(ruta, []byte(cab+"a1\n"), 0o644)
	_, p, _, _ := Seguir(ruta, Posicion{})
	f, _ := os.OpenFile(ruta, os.O_APPEND|os.O_WRONLY, 0)
	_, _ = f.WriteString("a2\n")
	f.Close()
	_ = os.Rename(ruta, ruta+".1")
	_ = os.Chtimes(ruta+".1", time.Now().Add(-time.Minute), time.Now().Add(-time.Minute))
	_ = os.WriteFile(ruta, []byte(cab+"b1\nb2\nb3\n"), 0o644)
	lineas, _, _, err := Seguir(ruta, p)
	if err != nil {
		t.Fatal(err)
	}
	if len(lineas) < 2 || string(lineas[0]) != "a2" {
		t.Fatalf("la misma cabecera no hace pasar una rotación por una copia: %q", lineas)
	}
}
