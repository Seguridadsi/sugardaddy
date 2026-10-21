// Pruebas de cache_acotada.go (código propio de SeguridadSI). Corren al
// construir la imagen (Dockerfile): si fallan, no hay imagen.
package metrics

import (
	"fmt"
	"runtime"
	"testing"
	"time"

	"github.com/ryanolee/go-pot/config"
)

func TestCacheAcotadaNoPasaDelMaximo(t *testing.T) {
	c := nuevaCacheAcotada(time.Hour, 100)
	for i := range 1000 {
		c.Set(fmt.Sprint(i), i, 0)
	}
	if n := c.ItemCount(); n != 100 {
		t.Fatalf("entradas: %d", n)
	}
	if _, ok := c.Get("0"); ok {
		t.Fatal("la más antigua tendría que haber salido")
	}
	if v, ok := c.Get("999"); !ok || v != 999 {
		t.Fatalf("la última: %v %v", v, ok)
	}
}

func TestCacheAcotadaSeQuedaLaQueSeUsa(t *testing.T) {
	c := nuevaCacheAcotada(time.Hour, 10)
	c.Set("viva", 1, 0)
	for i := range 100 {
		c.Get("viva")
		c.Set(fmt.Sprint(i), i, 0)
	}
	if _, ok := c.Get("viva"); !ok {
		t.Fatal("la que se usa no tiene que salir")
	}
}

func TestCacheAcotadaCaduca(t *testing.T) {
	ahora := time.Date(2026, 10, 17, 10, 0, 0, 0, time.UTC)
	c := nuevaCacheAcotada(time.Hour, 10)
	c.reloj = func() time.Time { return ahora }
	c.Set("a", 1, 0)
	ahora = ahora.Add(59 * time.Minute)
	if _, ok := c.Get("a"); !ok {
		t.Fatal("aún no ha caducado")
	}
	c.Set("a", 2, 0) // renueva
	ahora = ahora.Add(59 * time.Minute)
	if v, ok := c.Get("a"); !ok || v != 2 {
		t.Fatalf("renovada: %v %v", v, ok)
	}
	ahora = ahora.Add(2 * time.Minute)
	if _, ok := c.Get("a"); ok {
		t.Fatal("tendría que haber caducado")
	}
	if c.ItemCount() != 0 {
		t.Fatal("lo caducado que se ve se retira")
	}
	c.Set("b", 1, 0)
	c.Delete("b")
	if _, ok := c.Get("b"); ok {
		t.Fatal("Delete")
	}
}

// El hallazgo: con cada IP distinta, el TimeoutWatcher crecía sin tope (200.000
// IP, 200.000 entradas y 37 MiB más de memoria; un millón, el OOM).
func TestTimeoutWatcherAcotado(t *testing.T) {
	cfg := &config.Config{}
	w := &cfg.TimeoutWatcher
	w.Enabled, w.GraceRequests, w.GraceTimeout = true, 3, 100
	w.CacheHotPoolTTL, w.CacheColdPoolTTL = 3600, 172800
	w.LongestTimeout, w.UpperTimeoutBound = 7*24*60*60*1000, 60*1000
	w.TimeoutSubTenIncrement, w.TimeoutSubThirtyIncrement, w.TimeoutOverThirtyIncrement = 2000, 5000, 10000
	tw := NewTimeoutWatcher(cfg)

	var antes, despues runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&antes)
	for i := range 300000 {
		ip := fmt.Sprintf("http-10.%d.%d.%d", i>>16, (i>>8)&255, i&255)
		tw.GetTimeout(ip)
		if i%2 == 0 {
			tw.CommitToColdCache(ip, time.Minute)
		}
	}
	runtime.GC()
	runtime.ReadMemStats(&despues)
	if n := tw.hotCachePool.ItemCount(); n > maxIPsPorCache {
		t.Fatalf("caché caliente: %d entradas", n)
	}
	if n := tw.coldCachePool.ItemCount(); n > maxIPsPorCache {
		t.Fatalf("caché fría: %d entradas", n)
	}
	crece := int64(despues.HeapAlloc) - int64(antes.HeapAlloc)
	t.Logf("300.000 IP: %d y %d entradas, %.1f MiB", tw.hotCachePool.ItemCount(), tw.coldCachePool.ItemCount(), float64(crece)/(1<<20))
	if crece > 10<<20 {
		t.Fatalf("la memoria crece %.1f MiB con 300.000 IP", float64(crece)/(1<<20))
	}

	// La que sigue pidiendo conserva su espera: la cuarta ya no es de gracia.
	for range 4 {
		tw.GetTimeout("http-192.0.2.7")
	}
	if d := tw.GetTimeout("http-192.0.2.7"); d < 2*time.Second {
		t.Fatalf("la IP que insiste ha perdido su espera: %v", d)
	}
}
