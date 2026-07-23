FROM node:22.17.0-alpine3.22
WORKDIR /work
COPY mock-server.mjs runner.mjs healthcheck.mjs ./
USER node
EXPOSE 8080
CMD ["node", "mock-server.mjs"]
