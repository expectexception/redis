from setuptools import setup

setup(
    name="redis-cache-client",
    version="3.0.0",
    description="Python client SDK for Redis Caching Server REST API",
    py_modules=["cache_client"],
    python_requires=">=3.7",
    install_requires=["requests>=2.20.0"],
    extras_require={
        "async": ["httpx>=0.20.0"]
    },
)
