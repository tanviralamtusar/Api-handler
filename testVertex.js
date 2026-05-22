const axios = require('axios');

async function test() {
    console.log("🚀 Sending test request to Vertex API endpoint...");
    try {
        const response = await axios.post('http://localhost:3001/api/vertex/chat/completions', {
            model: 'gemini-3.1-pro-preview',
            messages: [
                { role: 'user', content: 'Explain vertex in simple terms' }
            ],
            stream: false
        }, {
            headers: {
                'Authorization': 'Bearer sk-test-key-12345',
                'Content-Type': 'application/json'
            }
        });
        console.log('\n🎉 Response Received Successfully!');
        console.log(JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('\n❌ Error sending request:', error.response ? error.response.data : error.message);
    }
}

test();
