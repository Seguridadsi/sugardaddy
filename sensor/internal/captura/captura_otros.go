//go:build !linux

package captura

import (
	"fmt"
	"os"
)

// Main: fuera de Linux no hay AF_PACKET.
func Main(args []string) int {
	fmt.Fprintln(os.Stderr, "the capture companion needs Linux (AF_PACKET)")
	return 1
}
