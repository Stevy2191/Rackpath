FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        nmap \
        iputils-ping \
        libpcap-dev \
        libpcap0.8 \
        gcc \
        python3-dev \
        net-tools \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV SCANNER_PORT=5001
EXPOSE 5001

CMD ["python", "app.py"]
