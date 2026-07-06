build:
	npm run build

test:
	npm run test

deploy:
	docker build -t order-service .
	docker push order-service:latest

.PHONY: build test deploy
