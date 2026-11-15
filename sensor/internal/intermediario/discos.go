package intermediario

import (
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"sync"

	"github.com/kinomakino/sugardaddy/sensor/internal/discos"
)

// Discos pasa al servicio de discos del anfitrión (sd-discos) lo que pide el
// sensor, de uno en uno. La carpeta es siempre la del sensor que conoce sd-motor.
type Discos struct {
	Buzon string
	Datos string
	mu    sync.Mutex
}

// Atender: POST /sd/v1/discos con un discos.Pedido; contesta con un discos.Resultado.
func (d *Discos) Atender(w http.ResponseWriter, r *http.Request) error {
	var p discos.Pedido
	b, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return err
	}
	if json.Unmarshal(b, &p) != nil {
		return rechazar("the disk request is not JSON")
	}
	if filepath.Clean(p.Datos) != filepath.Clean(d.Datos) {
		return rechazar("disks are only for the sensor folder")
	}
	d.mu.Lock()
	res, err := discos.PedirAlServicio(r.Context(), d.Buzon, p)
	d.mu.Unlock()
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/json")
	return json.NewEncoder(w).Encode(res)
}
