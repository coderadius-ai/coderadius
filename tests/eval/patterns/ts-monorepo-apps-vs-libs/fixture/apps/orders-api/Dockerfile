FROM node:22-slim
WORKDIR /app
COPY . .
RUN npm ci && npm run build -w=@acme/orders-api
CMD ["node", "apps/orders-api/dist/main.js"]
