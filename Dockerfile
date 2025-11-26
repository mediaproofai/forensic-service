FROM node:20-slim
RUN apt-get update && apt-get install -y libvips-dev ca-certificates
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --only=prod
COPY . .
EXPOSE 3001
CMD ["node","index.js"]
