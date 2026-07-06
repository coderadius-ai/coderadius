/**
 * Service S1
 * 
 * This service exposes /s1/status and calls S2.
 */

async function getS1Status() {
    console.log("S1 Status requested");
    
    // Call S2
    const s2Url = process.env.S2_API_URL || 'http://localhost:8081';
    try {
        const response = await fetch(`${s2Url}/s2/hello`);
        const data = await response.json();
        return { status: "OK", s2_response: data };
    } catch (err) {
        return { status: "ERROR", error: (err as Error).message };
    }
}

// Mocking the router
const routes = {
    'GET /s1/status': getS1Status
};
