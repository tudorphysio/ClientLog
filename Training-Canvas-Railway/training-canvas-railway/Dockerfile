FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json server.js app.js ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
