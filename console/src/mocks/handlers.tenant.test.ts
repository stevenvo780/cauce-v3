import { CauceApi } from '../api/client';

const api = new CauceApi('http://localhost');

describe('mock de perfil y documentos tenant-qualified', () => {
  it('conserva el tenant aunque el mismo alias se consulte en dos tenants', async () => {
    const [perfilSteven, perfilMiguel, mapaMiguel] = await Promise.all([
      api.getAgentPerfil('Steven', 'kant'),
      api.getAgentPerfil('Miguel', 'kant'),
      api.getAgentDocuments('Miguel', 'kant'),
    ]);

    expect(perfilSteven).toMatchObject({ publicado: true, tenant_id: 'Steven', alias: 'kant' });
    expect(perfilMiguel).toMatchObject({
      publicado: true, tenant_id: 'Miguel', alias: 'kant', exists: true,
    });
    expect(mapaMiguel).toMatchObject({ publicado: true, tenant_id: 'Miguel', alias: 'kant' });
  });

  it('contenido y escritura usan la ruta canónica y la escritura trae evidencia', async () => {
    const contenido = await api.getAgentDocumentContent('Miguel', 'kant', 'directive');
    const escrito = await api.putAgentDocumentContent(
      'Miguel', 'kant', 'directive', '# nuevo', contenido.sha, 'corrijo la ruta del manual',
    );

    expect(contenido).toMatchObject({ tenant_id: 'Miguel', alias: 'kant' });
    expect(escrito).toMatchObject({ state: 'applied', evidence: 'probe_write_ack' });
  });
});
