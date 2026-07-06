import axios, { AxiosRequestConfig } from 'axios';

/**
 * Internal HTTP wrapper used across the order-service.
 * Adds retry logic and standard headers to every outgoing request.
 *
 * This file is a "Patient Zero" for taint analysis:
 * it imports `axios` directly and should propagate taint to any consumer.
 */
export class ApiGateway {
    private baseUrl: string;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
    }

    async post<T = any>(path: string, body: unknown): Promise<T> {
        const config: AxiosRequestConfig = {
            headers: {
                'Content-Type': 'application/json',
                'X-Service': 'order-service',
            },
        };

        const response = await axios.post(`${this.baseUrl}${path}`, body, config);
        return response.data;
    }

    async get<T = any>(path: string): Promise<T> {
        const response = await axios.get(`${this.baseUrl}${path}`);
        return response.data;
    }
}
