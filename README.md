# Cluster Analyzer

Herramienta web para analizar direcciones Ethereum: obtiene transacciones vía Etherscan, construye un grafo de relaciones con vecinos, aplica heurísticas y calcula puntuaciones de riesgo a nivel de wallet y de clúster.

## Requisitos

- Python 3.12+ (recomendado)
- Una [API key de Etherscan](https://etherscan.io/apis)

## Configuración

1. Clona el repositorio e instala dependencias:

```bash
cd wallet-cluster-analyzer
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

En Linux o macOS usa `source .venv/bin/activate` en lugar de la línea de activación de Windows.

2. Variables de entorno: copia `.env.example` a `.env` y define `ETHERSCAN_API_KEY` con tu clave. Opcionalmente puedes ajustar `ETHERSCAN_BASE_URL` y `CHAIN_ID` según la red.

## Ejecución

Desde la carpeta del proyecto (con el entorno virtual activado):

```bash
uvicorn backend.main:app --reload
```

Abre el navegador en la raíz del servidor (por defecto `http://127.0.0.1:8000/`) para usar la interfaz. La API documentada está disponible en `/docs` (Swagger).

## API principal

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Comprobación de estado |
| POST | `/analyze` | Informe completo: riesgo, heurísticas, vecinos y grafo |
| GET | `/graph` | Solo el JSON del grafo (más ligero que `/analyze`) |

El cuerpo de `POST /analyze` admite `address`, `depth` (0–2), `force_refresh` y `neighbor_limit` opcional.

## Estructura del proyecto

- `backend/` — FastAPI, motor de clúster, fetch de transacciones, heurísticas y scoring
- `frontend/` — Interfaz estática y visualización del grafo
- `cache/` — Caché local de transacciones (JSON; no versionado en git)

## Licencia

Uso del repositorio según lo defina el propietario del proyecto.
