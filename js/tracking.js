(function() {
    const UTM_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'src', 'sck'];
    
    function captureUTMs() {
        const urlParams = new URLSearchParams(window.location.search);
        let utmData = {};
        let hasNewData = false;

        // Tenta recuperar dados existentes
        try {
            const existing = localStorage.getItem('utm_data');
            if (existing) {
                utmData = JSON.parse(existing);
            }
        } catch (e) {
            console.warn('Erro ao ler UTMs do localStorage', e);
        }

        // Sobrescreve/Adiciona com dados da URL atual
        UTM_PARAMS.forEach(param => {
            const value = urlParams.get(param);
            if (value) {
                utmData[param] = value;
                hasNewData = true;
            }
        });

        // Salva se houve mudança ou se é a primeira vez
        if (hasNewData || Object.keys(utmData).length > 0) {
            localStorage.setItem('utm_data', JSON.stringify(utmData));
            console.log('UTMs capturados:', utmData);
        }
    }

    // Executa ao carregar
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', captureUTMs);
    } else {
        captureUTMs();
    }
})();
