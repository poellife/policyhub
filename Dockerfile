FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PORT=8000
EXPOSE 8000
CMD ["gunicorn","-w","1","--threads","2","--max-requests","25","--max-requests-jitter","5","-t","300","-b","0.0.0.0:8000","app:app"]
