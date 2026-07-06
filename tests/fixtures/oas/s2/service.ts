/**
 * Service S2
 * 
 * This service exposes /s2/hello and calls S1 and an external API.
 */

async function getS2Hello() {
    console.log("S2 Hello requested");
    
    // Call S1
    const s1Url = process.env.S1_API_URL || 'http://localhost:8080';
    try {
        await fetch(`${s1Url}/s1/status`);
    } catch (err) {
        console.error("Failed to call S1", err);
    }

    // Call External API (from the example.yaml fixture)
    const externalUrl = process.env.EXTERNAL_API_URL || 'https://api.acme.com/inventory/v1';
    try {
        const response = await fetch(`${externalUrl}/inventory/sku_9001`);
        const data = await response.json();
        return { message: "Hello from S2", external_data: data };
    } catch (err) {
        return { message: "Hello from S2", error: (err as Error).message };
    }
}

// Mocking the router
const routes = {
    'GET /s2/hello': getS2Hello
};
