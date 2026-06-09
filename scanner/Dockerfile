FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        nmap \
        iputils-ping \
        libpcap-dev \
        net-tools \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV SCANNER_PORT=8000
EXPOSE 8000

CMD ["python", "app.py"]
