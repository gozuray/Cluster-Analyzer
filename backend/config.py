"""Shared settings (Etherscan-compatible API)."""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    etherscan_api_key: str = ""
    # Etherscan V2 unified endpoint; override for self-hosted / other providers
    etherscan_base_url: str = "https://api.etherscan.io/v2/api"
    chain_id: int = 1
    tx_page_size: int = 1000
    max_tx_pages: int = 10
    neighbor_limit: int = 24
    cache_dir: Path = Path(__file__).resolve().parent.parent / "cache"


settings = Settings()
